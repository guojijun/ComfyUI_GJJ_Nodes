import { app } from "/scripts/app.js";

(function () {
	"use strict";

	const EXTENSION_NAME = "Comfy.GJJ.WorkflowRepairNotice";
	const STYLE_ID = "gjj-workflow-repair-notice-style";
	const PANEL_ID = "gjj-workflow-repair-notice";
	const PATCH_FLAG = "__gjjWorkflowRepairNoticePatched";
	const AUTO_NAME_SCORE = 0.98;
	const SUGGEST_NAME_SCORE = 0.45;
	const SYSTEM_SUGGEST_NAME_SCORE = 0.18;
	const MAX_SUGGESTIONS = 4;
	const MAX_SYSTEM_SUGGESTIONS = 6;
	const RESOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

	let panel = null;
	let lastPlan = null;
	let lastModelNodes = [];
	let lastModelSuggestions = [];
	let modelSuggestionKey = "";
	let modelSuggestionReadyKey = "";
	let modelSuggestionError = "";
	let modelSuggestionTimer = null;
	let modelSuggestionSerial = 0;
	let rescanTimer = null;
	let originalLoadGraphData = null;
	const candidateInfoCache = new Map();

	function safeArray(value) {
		return Array.isArray(value) ? value : [];
	}

	function compactText(value) {
		return String(value ?? "").replace(/\s+/g, " ").trim();
	}

	function looksLikeResourceReference(value, node = null) {
		const text = compactText(value);
		if (!text) return false;
		if (RESOURCE_ID_RE.test(text)) return true;
		if (/^(resource|asset|file|media)[:/_-]/i.test(text)) return true;
		const props = node?.properties || {};
		return RESOURCE_ID_RE.test(compactText(props.resource_id || props.asset_id || props.file_id || props.gjj_resource_id));
	}

	function stripGjjPrefix(value) {
		return compactText(value)
			.replace(/^GJJ\s*·\s*/i, "")
			.replace(/^GJJ[_\s:/\\-]+/i, "")
			.replace(/^guojijun[_\s:/\\-]+/i, "");
	}

	function normalizeNodeName(value) {
		return stripGjjPrefix(value)
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/[^\w\u4e00-\u9fff]+/g, "")
			.replace(/^gjj/i, "")
			.toLowerCase();
	}

	function splitTokens(value) {
		return stripGjjPrefix(value)
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Za-z])(\d)/g, "$1 $2")
			.replace(/(\d)([A-Za-z])/g, "$1 $2")
			.split(/[^\w\u4e00-\u9fff]+/g)
			.map((item) => item.toLowerCase().trim())
			.filter((item) => item.length > 1 && item !== "gjj" && item !== "node");
	}

	function jaccardScore(left, right) {
		const a = new Set(left);
		const b = new Set(right);
		if (!a.size || !b.size) return 0;
		let hits = 0;
		for (const item of a) {
			if (b.has(item)) hits += 1;
		}
		return hits / Math.max(1, new Set([...a, ...b]).size);
	}

	function registry() {
		return globalThis.LiteGraph?.registered_node_types || {};
	}

	function nodeDataForCtor(nodeCtor) {
		return nodeCtor?.nodeData || nodeCtor?.prototype?.nodeData || {};
	}

	function nodeDisplayNames(type, nodeCtor) {
		const data = nodeDataForCtor(nodeCtor);
		return [
			type,
			nodeCtor?.title,
			nodeCtor?.comfyClass,
			data?.name,
			data?.display_name,
			data?.displayName,
			data?.title,
		].map(compactText).filter(Boolean);
	}

	function isRegisteredType(type) {
		const text = compactText(type);
		return !!text && !!registry()[text];
	}

	function isGjjCandidate(type, nodeCtor) {
		const data = nodeDataForCtor(nodeCtor);
		const text = `${type} ${nodeDisplayNames(type, nodeCtor).join(" ")} ${data?.category || ""}`;
		return /(^|[\s:/\\_-])GJJ([\s:/\\_-]|$)|GJJ\s*·|guojijun/i.test(text);
	}

	function registeredGjjCandidates() {
		return Object.entries(registry())
			.filter(([type, nodeCtor]) => isGjjCandidate(type, nodeCtor))
			.map(([type, nodeCtor]) => ({ type, nodeCtor, names: nodeDisplayNames(type, nodeCtor) }));
	}

	function registeredSystemCandidates() {
		return Object.entries(registry())
			.map(([type, nodeCtor]) => ({ type, nodeCtor, names: nodeDisplayNames(type, nodeCtor) }))
			.filter((candidate) => compactText(candidate.type));
	}

	function nameScore(missingType, candidate) {
		const missingNames = [missingType, stripGjjPrefix(missingType)].filter(Boolean);
		const candidateNames = candidate.names.length ? candidate.names : [candidate.type];
		let best = 0;
		for (const missingName of missingNames) {
			const missingNorm = normalizeNodeName(missingName);
			const missingTokens = splitTokens(missingName);
			for (const candidateName of candidateNames) {
				const candidateNorm = normalizeNodeName(candidateName);
				if (!missingNorm || !candidateNorm) continue;
				if (missingNorm === candidateNorm) best = Math.max(best, 1);
				if (missingNorm.length >= 5 && candidateNorm.includes(missingNorm)) best = Math.max(best, 0.82);
				if (candidateNorm.length >= 5 && missingNorm.includes(candidateNorm)) best = Math.max(best, 0.82);
				best = Math.max(best, jaccardScore(missingTokens, splitTokens(candidateName)) * 0.9);
			}
		}
		return Math.min(1, best);
	}

	function slotName(slot) {
		return compactText(slot?.name || slot?.label || slot?.localized_name || slot?.localizedName || "");
	}

	function slotType(slot) {
		const value = slot?.type ?? slot?.widget?.type ?? slot?.inputType ?? slot?.outputType ?? "";
		if (Array.isArray(value)) return value.map(String).join(",");
		return compactText(value);
	}

	function normalizedSlotName(slot) {
		return slotName(slot).replace(/[：:]/g, "").replace(/\s+/g, "").toLowerCase();
	}

	function splitTypes(value) {
		return compactText(value)
			.toUpperCase()
			.split(/[,\s|/]+/g)
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function typesCompatible(a, b) {
		const left = splitTypes(a);
		const right = splitTypes(b);
		if (!left.length || !right.length || left.includes("*") || right.includes("*")) return true;
		return left.some((item) => right.includes(item));
	}

	function slotsFromRuntime(slots) {
		return safeArray(slots).map((slot, index) => ({
			index,
			name: slotName(slot) || `接口 ${index + 1}`,
			type: slotType(slot),
		}));
	}

	function slotFromInputSpec(name, spec, index) {
		let type = "";
		if (Array.isArray(spec)) {
			const first = spec[0];
			type = Array.isArray(first) ? first.join(",") : compactText(first);
		} else if (spec && typeof spec === "object") {
			type = compactText(spec.type || spec.inputType || spec.name || "");
		}
		return { index, name: compactText(name), type };
	}

	function fallbackInputsFromNodeData(data) {
		const input = data?.input || {};
		const result = [];
		for (const group of [input.required, input.optional]) {
			if (!group || typeof group !== "object") continue;
			for (const [name, spec] of Object.entries(group)) {
				result.push(slotFromInputSpec(name, spec, result.length));
			}
		}
		return result;
	}

	function fallbackOutputsFromNodeData(data) {
		const types = safeArray(data?.output);
		const names = safeArray(data?.output_name || data?.output_names);
		return types.map((type, index) => ({
			index,
			name: compactText(names[index] || type || `输出 ${index + 1}`),
			type: compactText(type),
		}));
	}

	function candidateInfo(type, nodeCtor) {
		if (candidateInfoCache.has(type)) return candidateInfoCache.get(type);
		let temp = null;
		try {
			temp = globalThis.LiteGraph?.createNode?.(type) || null;
		} catch (error) {
			console.warn(`[GJJ] 创建候选节点失败：${type}`, error);
		}
		const data = nodeDataForCtor(nodeCtor || registry()[type]);
		const info = {
			type,
			display: compactText(temp?.title || nodeCtor?.title || data?.display_name || data?.title || type),
			inputs: slotsFromRuntime(temp?.inputs).filter((slot) => slot.name || slot.type),
			outputs: slotsFromRuntime(temp?.outputs).filter((slot) => slot.name || slot.type),
			widgets: safeArray(temp?.widgets).map((widget) => compactText(widget?.name || widget?.label)).filter(Boolean),
		};
		if (!info.inputs.length) info.inputs = fallbackInputsFromNodeData(data);
		if (!info.outputs.length) info.outputs = fallbackOutputsFromNodeData(data);
		candidateInfoCache.set(type, info);
		return info;
	}

	function serializedInputs(node) {
		return safeArray(node?.inputs).map((slot, index) => ({
			index,
			name: slotName(slot) || `输入 ${index + 1}`,
			type: slotType(slot),
			link: slot?.link,
			raw: slot,
		}));
	}

	function serializedOutputs(node) {
		return safeArray(node?.outputs).map((slot, index) => ({
			index,
			name: slotName(slot) || `输出 ${index + 1}`,
			type: slotType(slot),
			links: safeArray(slot?.links).slice(),
			raw: slot,
		}));
	}

	function bestSlotMatch(targetSlots, sourceSlot, used = new Set()) {
		const sourceName = normalizedSlotName(sourceSlot);
		const sourceType = slotType(sourceSlot);
		let index = targetSlots.findIndex((slot) => (
			!used.has(slot.index)
			&& normalizedSlotName(slot) === sourceName
			&& typesCompatible(slotType(slot), sourceType)
		));
		if (index >= 0) return targetSlots[index].index;

		index = targetSlots.findIndex((slot) => !used.has(slot.index) && sourceName && normalizedSlotName(slot) === sourceName);
		if (index >= 0) return targetSlots[index].index;

		const byType = targetSlots.filter((slot) => !used.has(slot.index) && typesCompatible(slotType(slot), sourceType));
		if (byType.length === 1) return byType[0].index;
		if (sourceSlot.index < targetSlots.length && !used.has(sourceSlot.index)) return sourceSlot.index;
		return -1;
	}

	function buildSlotMap(oldSlots, newSlots) {
		const map = new Map();
		const used = new Set();
		for (const oldSlot of oldSlots) {
			const next = bestSlotMatch(newSlots, oldSlot, used);
			if (next >= 0) {
				map.set(oldSlot.index, next);
				used.add(next);
			}
		}
		return map;
	}

	function slotCompatibilityScore(oldSlots, newSlots) {
		if (!oldSlots.length) return 1;
		if (!newSlots.length) return 0;
		const used = new Set();
		let hits = 0;
		for (const oldSlot of oldSlots) {
			const next = bestSlotMatch(newSlots, oldSlot, used);
			if (next >= 0) {
				hits += 1;
				used.add(next);
			}
		}
		return hits / Math.max(1, oldSlots.length);
	}

	function widgetCompatibilityScore(oldValues, candidateWidgets) {
		const count = safeArray(oldValues).length;
		if (!count || !candidateWidgets.length) return 1;
		const diff = Math.abs(count - candidateWidgets.length);
		return diff === 0 ? 1 : Math.max(0, 1 - diff / Math.max(count, candidateWidgets.length));
	}

	function candidateMatchForNode(node, candidate) {
		const info = candidateInfo(candidate.type, candidate.nodeCtor);
		const inputs = serializedInputs(node);
		const outputs = serializedOutputs(node);
		const inputScore = slotCompatibilityScore(inputs, info.inputs);
		const outputScore = slotCompatibilityScore(outputs, info.outputs);
		const widgetsScore = widgetCompatibilityScore(node?.widgets_values, info.widgets);
		const hasSerializedParams = inputs.length > 0 || outputs.length > 0 || safeArray(node?.widgets_values).length > 0;
		const names = nameScore(node?.type, candidate);
		const score = names * 0.56 + inputScore * 0.2 + outputScore * 0.18 + widgetsScore * 0.06;
		const slotsOk = inputScore >= 0.86 && outputScore >= 0.82;
		const widgetsOk = widgetsScore >= 0.72;
		const auto = hasSerializedParams && names >= AUTO_NAME_SCORE && slotsOk && widgetsOk;
		const reason = [
			auto ? "名称与接口一致" : "名称接近",
			`输入 ${Math.round(inputScore * 100)}%`,
			`输出 ${Math.round(outputScore * 100)}%`,
			info.widgets.length ? `参数 ${Math.round(widgetsScore * 100)}%` : "",
		].filter(Boolean).join("，");
		return { ...candidate, info, score, nameScore: names, inputScore, outputScore, widgetsScore, auto, reason };
	}

	function topCandidatesForMissingNode(node) {
		const candidates = registeredGjjCandidates()
			.map((candidate) => ({ ...candidate, quickNameScore: nameScore(node?.type, candidate) }))
			.filter((candidate) => candidate.quickNameScore >= SUGGEST_NAME_SCORE)
			.map((candidate) => candidateMatchForNode(node, candidate))
			.sort((a, b) => b.score - a.score);
		return candidates.slice(0, MAX_SUGGESTIONS);
	}

	function topSystemCandidatesForMissingNode(node) {
		return registeredSystemCandidates()
			.map((candidate) => ({ ...candidate, score: nameScore(node?.type, candidate) }))
			.filter((candidate) => candidate.score >= SYSTEM_SUGGEST_NAME_SCORE && compactText(candidate.type) !== compactText(node?.type))
			.sort((a, b) => b.score - a.score || compactText(a.type).localeCompare(compactText(b.type)))
			.slice(0, MAX_SYSTEM_SUGGESTIONS)
			.map((candidate) => ({
				type: candidate.type,
				display: candidate.names.find((name) => name && name !== candidate.type) || candidate.type,
				score: candidate.score,
			}));
	}

	function graphRoot(data) {
		if (data && Array.isArray(data.nodes)) return data;
		if (data?.workflow && Array.isArray(data.workflow.nodes)) return data.workflow;
		return null;
	}

	function cloneWorkflow(data) {
		try {
			if (typeof structuredClone === "function") return structuredClone(data);
		} catch (_) {}
		try {
			return JSON.parse(JSON.stringify(data));
		} catch (_) {
			return null;
		}
	}

	function linkId(link) {
		return Array.isArray(link) ? link[0] : link?.id;
	}

	function linkOriginId(link) {
		return Array.isArray(link) ? link[1] : link?.origin_id;
	}

	function linkOriginSlot(link) {
		return Array.isArray(link) ? link[2] : link?.origin_slot;
	}

	function linkTargetId(link) {
		return Array.isArray(link) ? link[3] : link?.target_id;
	}

	function linkTargetSlot(link) {
		return Array.isArray(link) ? link[4] : link?.target_slot;
	}

	function setLinkOriginSlot(link, slot) {
		if (Array.isArray(link)) link[2] = slot;
		else if (link) link.origin_slot = slot;
	}

	function setLinkTargetSlot(link, slot) {
		if (Array.isArray(link)) link[4] = slot;
		else if (link) link.target_slot = slot;
	}

	function serializedLinks(root) {
		if (Array.isArray(root?.links)) return root.links;
		if (root?.links && typeof root.links === "object") return Object.values(root.links);
		return [];
	}

	function syncNodeInputLinks(root, node) {
		const inputLinks = new Map();
		for (const link of serializedLinks(root)) {
			if (String(linkTargetId(link)) === String(node?.id)) {
				inputLinks.set(Number(linkTargetSlot(link)), linkId(link));
			}
		}
		for (const [index, input] of safeArray(node?.inputs).entries()) {
			input.link = inputLinks.has(index) ? inputLinks.get(index) : null;
		}
	}

	function syncNodeOutputLinks(root, node) {
		const outputLinks = new Map();
		for (const link of serializedLinks(root)) {
			if (String(linkOriginId(link)) !== String(node?.id)) continue;
			const slot = Number(linkOriginSlot(link));
			if (!outputLinks.has(slot)) outputLinks.set(slot, []);
			outputLinks.get(slot).push(linkId(link));
		}
		for (const [index, output] of safeArray(node?.outputs).entries()) {
			output.links = outputLinks.get(index) || [];
			output.slot_index = index;
		}
	}

	function replaceSerializedSlots(root, node, oldInputs, oldOutputs, candidate) {
		const nextInputs = safeArray(candidate?.info?.inputs);
		const nextOutputs = safeArray(candidate?.info?.outputs);
		const inputMap = buildSlotMap(oldInputs, nextInputs);
		const outputMap = buildSlotMap(oldOutputs, nextOutputs);

		for (const link of serializedLinks(root)) {
			if (String(linkTargetId(link)) === String(node?.id)) {
				const next = inputMap.get(Number(linkTargetSlot(link)));
				if (next !== undefined) setLinkTargetSlot(link, next);
			}
			if (String(linkOriginId(link)) === String(node?.id)) {
				const next = outputMap.get(Number(linkOriginSlot(link)));
				if (next !== undefined) setLinkOriginSlot(link, next);
			}
		}

		if (nextInputs.length && oldInputs.length) {
			node.inputs = nextInputs.map((slot, index) => {
				const oldIndex = [...inputMap.entries()].find(([, next]) => next === index)?.[0];
				const old = oldIndex === undefined ? {} : (oldInputs[oldIndex]?.raw || {});
				return { ...old, name: slot.name, type: slot.type || old.type || "*", link: old.link ?? null };
			});
			syncNodeInputLinks(root, node);
		}
		if (nextOutputs.length && oldOutputs.length) {
			node.outputs = nextOutputs.map((slot, index) => {
				const oldIndex = [...outputMap.entries()].find(([, next]) => next === index)?.[0];
				const old = oldIndex === undefined ? {} : (oldOutputs[oldIndex]?.raw || {});
				return { ...old, name: slot.name, type: slot.type || old.type || "*", links: [], slot_index: index };
			});
			syncNodeOutputLinks(root, node);
		}
	}

	function applySerializedReplacement(root, node, candidate) {
		const oldType = compactText(node?.type);
		const oldInputs = serializedInputs(node);
		const oldOutputs = serializedOutputs(node);
		node.type = candidate.type;
		if (!node.properties || typeof node.properties !== "object") node.properties = {};
		node.properties["Node name for S&R"] = candidate.type;
		node.properties["GJJ修复替换自"] = oldType;
		if (!compactText(node.title) || normalizeNodeName(node.title) === normalizeNodeName(oldType)) {
			node.title = candidate.info?.display || candidate.type;
		}
		replaceSerializedSlots(root, node, oldInputs, oldOutputs, candidate);
	}

	function emptyPlan() {
		return {
			sourceWorkflow: null,
			repairable: [],
			appliedReplacements: [],
			unresolved: [],
			missingResources: [],
			checkedMissingCount: 0,
			error: null,
		};
	}

	function prepareWorkflowRepair(data) {
		const root = graphRoot(data);
		const plan = emptyPlan();
		if (!root) return plan;
		plan.sourceWorkflow = cloneWorkflow(data);
		const missingNodes = safeArray(root.nodes).filter((node) => {
			const type = compactText(node?.type);
			return type && !isRegisteredType(type);
		});
		plan.checkedMissingCount = missingNodes.length;
		if (!missingNodes.length) return plan;
		for (const node of missingNodes) {
			const type = compactText(node?.type);
			if (looksLikeResourceReference(type, node)) {
				plan.missingResources.push({
					id: node.id,
					resource: type,
					title: compactText(node?.title),
					reason: "这是工作流资源引用，不是可替换的节点注册名。",
				});
				continue;
			}
			const candidates = topCandidatesForMissingNode(node);
			const best = candidates[0] || null;
			if (best?.auto) {
				plan.repairable.push({
					id: node.id,
					oldType: type,
					newType: best.type,
					display: best.info?.display || best.type,
					reason: best.reason,
				});
			} else {
				plan.unresolved.push({
					id: node.id,
					type,
					candidates: candidates.map((candidate) => ({
						type: candidate.type,
						display: candidate.info?.display || candidate.type,
						score: candidate.score,
						reason: candidate.reason,
					})),
					systemCandidates: candidates.length ? [] : topSystemCandidatesForMissingNode(node),
				});
			}
		}
		return plan;
	}

	function ensureStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `
			#${PANEL_ID} {
				position: fixed;
				right: 14px;
				bottom: 14px;
				z-index: 1000000;
				display: none;
				width: min(410px, calc(100vw - 28px));
				max-height: min(560px, calc(100vh - 28px));
				flex-direction: column;
				overflow: hidden;
				border: 1px solid rgba(255, 190, 86, .45);
				border-radius: 8px;
				background: rgba(18, 23, 26, .97);
				color: #edf6f7;
				box-shadow: 0 14px 38px rgba(0, 0, 0, .36);
				font: 12px/1.38 ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
				user-select: none;
			}
			#${PANEL_ID} .gjj-repair-head {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 8px 9px;
				border-bottom: 1px solid rgba(255, 190, 86, .22);
				background: linear-gradient(90deg, rgba(80, 47, 15, .92), rgba(26, 30, 32, .96));
			}
			#${PANEL_ID} .gjj-repair-title {
				font-weight: 800;
				white-space: nowrap;
			}
			#${PANEL_ID} .gjj-repair-summary {
				flex: 1;
				min-width: 0;
				overflow: hidden;
				color: #ffdca3;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			#${PANEL_ID} button {
				min-width: 24px;
				height: 24px;
				border: 1px solid rgba(255, 255, 255, .16);
				border-radius: 6px;
				background: rgba(255, 255, 255, .08);
				color: #edf6f7;
				cursor: pointer;
				font: 700 12px/22px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
				padding: 0 7px;
			}
			#${PANEL_ID} button:hover { background: rgba(255, 255, 255, .16); }
			#${PANEL_ID} button:disabled {
				cursor: default;
				opacity: .42;
			}
			#${PANEL_ID} .gjj-repair-body {
				display: flex;
				flex-direction: column;
				gap: 7px;
				overflow: auto;
				padding: 9px;
			}
			#${PANEL_ID} .gjj-repair-actions {
				display: flex;
				gap: 6px;
				flex-wrap: wrap;
			}
			#${PANEL_ID} .gjj-repair-actions button {
				height: 26px;
				line-height: 24px;
			}
			#${PANEL_ID} .gjj-repair-section {
				border: 1px solid rgba(132, 164, 176, .18);
				border-radius: 7px;
				overflow: hidden;
				background: rgba(255, 255, 255, .035);
			}
			#${PANEL_ID} .gjj-repair-section-title {
				padding: 6px 8px;
				border-bottom: 1px solid rgba(132, 164, 176, .12);
				color: #bceee0;
				font-weight: 800;
			}
			#${PANEL_ID} .gjj-repair-row {
				padding: 6px 8px;
				border-bottom: 1px solid rgba(132, 164, 176, .09);
				color: #dce9eb;
			}
			#${PANEL_ID} .gjj-repair-row:last-child { border-bottom: 0; }
			#${PANEL_ID} .gjj-repair-line {
				display: flex;
				align-items: flex-start;
				gap: 7px;
			}
			#${PANEL_ID} .gjj-repair-main {
				flex: 1;
				min-width: 0;
				font-weight: 700;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-copy {
				height: 22px;
				min-width: 0;
				line-height: 20px;
				padding: 0 6px;
				font-size: 11px;
				white-space: nowrap;
			}
			#${PANEL_ID} .gjj-repair-sub {
				margin-top: 3px;
				color: #aebfc5;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-current-model {
				margin-top: 4px;
				color: #aebfc5;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-model-list {
				display: flex;
				flex-direction: column;
				gap: 5px;
				margin-top: 6px;
			}
			#${PANEL_ID} .gjj-repair-model-candidate {
				display: grid;
				grid-template-columns: minmax(0, 1fr) 52px;
				align-items: center;
				gap: 7px;
				padding: 5px 6px;
				border: 1px solid rgba(255, 209, 127, .18);
				border-radius: 6px;
				background: rgba(255, 255, 255, .035);
			}
			#${PANEL_ID} .gjj-repair-model-name {
				min-width: 0;
				color: #f4e3b8;
				font-weight: 800;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-model-meta {
				margin-top: 2px;
				color: #96aab0;
				font-size: 11px;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-replace {
				height: 24px;
				min-width: 0;
				line-height: 22px;
				padding: 0 8px;
				white-space: nowrap;
			}
			#${PANEL_ID} .gjj-repair-node-list {
				display: flex;
				flex-direction: column;
				gap: 5px;
				margin-top: 6px;
			}
			#${PANEL_ID} .gjj-repair-node-candidate {
				display: grid;
				grid-template-columns: minmax(0, 1fr) 52px;
				align-items: center;
				gap: 7px;
				padding: 5px 6px;
				border: 1px solid rgba(188, 238, 224, .16);
				border-radius: 6px;
				background: rgba(255, 255, 255, .035);
			}
			#${PANEL_ID} .gjj-repair-node-name {
				min-width: 0;
				color: #d7fff2;
				font-weight: 800;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .gjj-repair-node-meta {
				margin-top: 2px;
				color: #96aab0;
				font-size: 11px;
				overflow-wrap: anywhere;
			}
			#${PANEL_ID} .ok { color: #8df0ba; }
			#${PANEL_ID} .warn { color: #ffd17f; }
			#${PANEL_ID} .bad { color: #ff9c9c; }
		`;
		document.head.appendChild(style);
	}

	function ensurePanel() {
		if (panel?.isConnected) return panel;
		ensureStyles();
		panel = document.createElement("div");
		panel.id = PANEL_ID;
		document.body.appendChild(panel);
		return panel;
	}

	async function copyText(value, message = "已复制。") {
		const text = String(value || "");
		if (!text) return;
		try {
			if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(text);
			showToast(message, "ok");
		} catch (_) {
			console.log(text);
			showToast("复制失败，已输出到控制台。");
		}
	}

	function row(main, sub = "", tone = "", options = {}) {
		const item = document.createElement("div");
		item.className = "gjj-repair-row";
		const line = document.createElement("div");
		line.className = "gjj-repair-line";
		const title = document.createElement("div");
		title.className = `gjj-repair-main ${tone}`;
		title.textContent = main;
		line.appendChild(title);
		if (options.copyText) {
			const copy = document.createElement("button");
			copy.type = "button";
			copy.className = "gjj-repair-copy";
			copy.textContent = options.copyLabel || "复制";
			copy.title = options.copyTitle || "复制";
			copy.addEventListener("click", () => copyText(options.copyText, options.copyMessage || "已复制。"));
			line.appendChild(copy);
		}
		item.appendChild(line);
		if (sub) {
			const detail = document.createElement("div");
			detail.className = "gjj-repair-sub";
			detail.textContent = sub;
			item.appendChild(detail);
		}
		return item;
	}

	function section(titleText, rows) {
		const wrap = document.createElement("div");
		wrap.className = "gjj-repair-section";
		const title = document.createElement("div");
		title.className = "gjj-repair-section-title";
		title.textContent = titleText;
		wrap.appendChild(title);
		for (const item of rows) wrap.appendChild(item);
		return wrap;
	}

	function graphNodes() {
		return safeArray(app?.graph?._nodes).filter(Boolean);
	}

	function summonApi() {
		return globalThis.GJJ_SummonModel || null;
	}

	function missingModelNodes() {
		const api = summonApi();
		if (!api?.nodeHasMissingModelSignal) return [];
		return graphNodes().filter((node) => {
			try {
				return api.nodeHasMissingModelSignal(node);
			} catch (_) {
				return false;
			}
		});
	}

	function missingModelWidgetCount(nodes) {
		const api = summonApi();
		if (!api?.findModelWidgets || !api?.widgetLooksMissing) return nodes.length;
		let count = 0;
		for (const node of nodes) {
			const widgets = api.findModelWidgets(node).filter((widget) => {
				try {
					return api.widgetLooksMissing(node, widget);
				} catch (_) {
					return false;
				}
			});
			count += widgets.length || 1;
		}
		return count;
	}

	function nodeTitle(node) {
		return compactText(node?.title || node?.type || node?.comfyClass || `节点 ${node?.id ?? ""}`);
	}

	function buildModelSuggestionQueries(nodes) {
		const api = summonApi();
		if (!api?.findModelWidgets || !api?.widgetLooksMissing || !api?.fetchSummonMatches) return { queries: [], refs: new Map() };
		const refs = new Map();
		const queries = [];
		const skipValueRe = /^(|none|null|undefined|nan|auto|自动|disable|disabled|禁用|\[未启用\]|\[未找到模型\]|\[none\])$/i;
		for (const node of nodes) {
			for (const widget of safeArray(api.findModelWidgets(node))) {
				let missing = false;
				try {
					missing = api.widgetLooksMissing(node, widget);
				} catch (_) {
					missing = false;
				}
				if (!missing) continue;
				const value = compactText(api.currentWidgetValue?.(widget) ?? widget?.value ?? "");
				if (!value || skipValueRe.test(value)) continue;
				const id = `${node?.id ?? "node"}:${queries.length}:${api.widgetName?.(widget) || widget?.name || ""}`;
				const query = {
					id,
					node_id: node?.id,
					node_type: api.nodeName?.(node) || node?.type || "",
					widget_name: api.widgetName?.(widget) || widget?.name || "",
					value,
					categories: api.inferCategories?.(node, widget) || [],
					allowed_values: api.allowedModelValues?.(widget) || [],
					limit: 8,
				};
				queries.push(query);
				refs.set(id, {
					nodeId: node?.id,
					nodeTitle: nodeTitle(node),
					widgetName: query.widget_name || "模型",
					value,
				});
			}
		}
		return { queries, refs };
	}

	function modelSuggestionsKey(nodes) {
		const api = summonApi();
		if (!api?.findModelWidgets) return "";
		const parts = [];
		for (const node of nodes) {
			for (const widget of safeArray(api.findModelWidgets(node))) {
				const value = compactText(api.currentWidgetValue?.(widget) ?? widget?.value ?? "");
				parts.push(`${node?.id}:${api.widgetName?.(widget) || widget?.name || ""}:${value}`);
			}
		}
		return parts.join("|");
	}

	function sortedModelMatches(matches) {
		return safeArray(matches)
			.slice()
			.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0) || compactText(a?.name).localeCompare(compactText(b?.name)));
	}

	function formatModelMatches(matches) {
		const list = sortedModelMatches(matches).slice(0, 5);
		const best = Math.max(1, Number(list[0]?.score || 0));
		return list.map((match, index) => {
			const relative = Math.max(1, Math.round(Number(match?.score || 0) / best * 100));
			const category = compactText(match?.category);
			const reason = compactText(match?.reason);
			return `${index + 1}. ${category ? `${category}/` : ""}${compactText(match?.name)}（相似度 ${relative}%${reason ? `，${reason}` : ""}）`;
		}).join("；");
	}

	function findModelSuggestionTarget(item) {
		const api = summonApi();
		if (!api?.findModelWidgets) return null;
		const node = graphNodes().find((candidate) => String(candidate?.id ?? "") === String(item?.nodeId ?? ""));
		if (!node) return null;
		const widgetName = compactText(item?.widgetName);
		const widget = safeArray(api.findModelWidgets(node)).find((candidate) => {
			const name = compactText(api.widgetName?.(candidate) || candidate?.name || "");
			if (widgetName && name === widgetName) return true;
			const value = compactText(api.currentWidgetValue?.(candidate) ?? candidate?.value ?? "");
			return value && value === compactText(item?.value);
		});
		return widget ? { node, widget } : null;
	}

	function confirmModelReplacement(item, match) {
		if (!match?.needs_confirmation) return true;
		const message = [
			"这个候选属于第二梯队，可能只是格式、量化、封装或备注相近。",
			"",
			`节点：#${item?.nodeId} ${item?.nodeTitle || ""}`,
			`控件：${item?.widgetName || "模型"}`,
			`当前：${item?.value || ""}`,
			`替换为：${match?.name || ""}`,
			match?.reason ? `原因：${match.reason}` : "",
			"",
			"是否替换？",
		].filter((line) => line !== "").join("\n");
		try {
			return window.confirm(message);
		} catch (_) {
			return false;
		}
	}

	function replaceModelSuggestion(item, match) {
		const api = summonApi();
		const target = findModelSuggestionTarget(item);
		if (!api?.setWidgetValue || !target || !match?.name) {
			showToast("替换失败：没有找到对应的模型控件。");
			return;
		}
		if (!confirmModelReplacement(item, match)) {
			showToast("已取消替换。");
			return;
		}
		if (!api.setWidgetValue(target.node, target.widget, String(match.name))) {
			showToast("替换失败：候选模型不能写入这个控件。");
			return;
		}
		showToast(`已替换：${compactText(match.name)}`, "ok");
		clearTimeout(rescanTimer);
		rescanTimer = setTimeout(() => renderNotice(lastPlan), 260);
	}

	function modelSuggestionRow(item) {
		const wrap = row(`#${item.nodeId} ${item.nodeTitle} / ${item.widgetName}`, "", item.matches?.length ? "warn" : "bad");
		const current = document.createElement("div");
		current.className = "gjj-repair-current-model";
		current.textContent = `当前：${item.value}`;
		wrap.appendChild(current);

		const matches = sortedModelMatches(item.matches).slice(0, 5);
		if (!matches.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-repair-sub bad";
			empty.textContent = "暂无本地候选。";
			wrap.appendChild(empty);
			return wrap;
		}

		const list = document.createElement("div");
		list.className = "gjj-repair-model-list";
		const best = Math.max(1, Number(matches[0]?.score || 0));
		for (const [index, match] of matches.entries()) {
			const line = document.createElement("div");
			line.className = "gjj-repair-model-candidate";
			const info = document.createElement("div");
			const name = document.createElement("div");
			name.className = "gjj-repair-model-name";
			const category = compactText(match?.category);
			name.textContent = `${index + 1}. ${category ? `${category}/` : ""}${compactText(match?.name)}`;
			const meta = document.createElement("div");
			meta.className = "gjj-repair-model-meta";
			const relative = Math.max(1, Math.round(Number(match?.score || 0) / best * 100));
			const reason = compactText(match?.reason);
			meta.textContent = `相似度 ${relative}%${reason ? `，${reason}` : ""}`;
			info.append(name, meta);

			const replace = document.createElement("button");
			replace.type = "button";
			replace.className = "gjj-repair-replace";
			replace.textContent = "替换";
			replace.title = `用这个候选替换当前模型\n${compactText(match?.name)}`;
			replace.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				replaceModelSuggestion(item, match);
			});
			line.append(info, replace);
			list.appendChild(line);
		}
		wrap.appendChild(list);
		return wrap;
	}

	async function refreshModelSuggestions(nodes, key) {
		const api = summonApi();
		if (!api?.fetchSummonMatches) return;
		const serial = ++modelSuggestionSerial;
		const { queries, refs } = buildModelSuggestionQueries(nodes);
		if (!queries.length) {
			lastModelSuggestions = [];
			modelSuggestionReadyKey = key;
			modelSuggestionError = "";
			if (key === modelSuggestionKey) renderNotice(lastPlan, { skipModelScan: true });
			return;
		}
		try {
			const data = await api.fetchSummonMatches(queries);
			if (serial !== modelSuggestionSerial) return;
			lastModelSuggestions = safeArray(data?.results)
				.map((result) => {
					const ref = refs.get(String(result?.id || ""));
					const matches = sortedModelMatches(result?.matches || []);
					return ref ? { ...ref, matches, bestScore: Number(matches[0]?.score || 0) } : null;
				})
				.filter(Boolean)
				.sort((a, b) => b.bestScore - a.bestScore || compactText(a.nodeTitle).localeCompare(compactText(b.nodeTitle)));
			modelSuggestionReadyKey = key;
			modelSuggestionError = "";
			if (key === modelSuggestionKey) renderNotice(lastPlan, { skipModelScan: true });
		} catch (error) {
			console.warn("[GJJ] 模型候选扫描失败:", error);
			if (serial !== modelSuggestionSerial) return;
			lastModelSuggestions = [];
			modelSuggestionReadyKey = key;
			modelSuggestionError = compactText(error?.message || error);
			if (key === modelSuggestionKey) renderNotice(lastPlan, { skipModelScan: true });
		}
	}

	function scheduleModelSuggestionScan(nodes) {
		const key = modelSuggestionsKey(nodes);
		if (!key) {
			modelSuggestionKey = "";
			modelSuggestionReadyKey = "";
			modelSuggestionError = "";
			lastModelSuggestions = [];
			return;
		}
		if (key === modelSuggestionKey) return;
		modelSuggestionKey = key;
		modelSuggestionReadyKey = "";
		modelSuggestionError = "";
		lastModelSuggestions = [];
		clearTimeout(modelSuggestionTimer);
		modelSuggestionTimer = setTimeout(() => refreshModelSuggestions(nodes, key), 180);
	}

	function copyNoticeText(plan, modelCount, modelSuggestions = []) {
		const lines = [];
		lines.push("GJJ 工作流修复建议");
		if (modelCount) lines.push(`缺失模型：${modelCount} 个，可使用“召唤模型”匹配本地文件。`);
		for (const item of safeArray(plan?.missingResources)) {
			lines.push(`缺失资源：#${item.id} ${item.resource}${item.title ? ` / ${item.title}` : ""}`);
		}
		for (const item of safeArray(modelSuggestions)) {
			lines.push(`模型候选：#${item.nodeId} ${item.nodeTitle} / ${item.widgetName} / 当前：${item.value}`);
			const matches = sortedModelMatches(item.matches).slice(0, 5);
			for (const [index, match] of matches.entries()) {
				lines.push(`  ${index + 1}. ${match.category ? `${match.category}/` : ""}${match.name}（score: ${match.score ?? ""}${match.reason ? `，${match.reason}` : ""}）`);
			}
		}
		for (const item of safeArray(plan?.repairable)) {
			lines.push(`可修复节点：#${item.id} ${item.oldType} -> ${item.newType}（${item.reason}）`);
		}
		for (const item of safeArray(plan?.appliedReplacements)) {
			lines.push(`已修复节点：#${item.id} ${item.oldType} -> ${item.newType}（${item.reason}）`);
		}
		for (const item of safeArray(plan?.unresolved)) {
			lines.push(`缺失节点：#${item.id} ${item.type}`);
			if (item.candidates?.length) {
				for (const candidate of item.candidates) {
					lines.push(`  建议：${candidate.type}（${candidate.reason}）`);
				}
			} else if (item.systemCandidates?.length) {
				for (const [index, candidate] of item.systemCandidates.entries()) {
					lines.push(`  系统相近 ${index + 1}. ${candidate.type}（相似度 ${Math.round(candidate.score * 100)}%）`);
				}
			}
		}
		if (plan?.error) lines.push(`加载提示：${plan.error}`);
		return lines.join("\n");
	}

	function showToast(message, tone = "info") {
		const api = summonApi();
		if (api?.showToast) {
			api.showToast(message, tone);
			return;
		}
		console.log(`[GJJ] ${message}`);
	}

	async function runSummonModelRepair() {
		const api = summonApi();
		const targets = lastModelNodes.length ? lastModelNodes : missingModelNodes();
		if (!api?.summonModelsForNodes || !targets.length) {
			showToast("没有找到可召唤的缺失模型。");
			return;
		}
		await api.summonModelsForNodes(targets);
		clearTimeout(rescanTimer);
		rescanTimer = setTimeout(() => renderNotice(lastPlan), 300);
	}

	function candidateFromRepairItem(item, node) {
		const nodeCtor = registry()[item?.newType];
		if (!nodeCtor) return null;
		const candidate = {
			type: item.newType,
			nodeCtor,
			names: nodeDisplayNames(item.newType, nodeCtor),
		};
		const matched = candidateMatchForNode(node, candidate);
		return matched?.auto ? matched : null;
	}

	function buildNodeRepairWorkflow(plan) {
		const source = plan?.sourceWorkflow;
		const root = graphRoot(source);
		if (!root || !safeArray(plan?.repairable).length) return null;
		const working = cloneWorkflow(source);
		const workingRoot = graphRoot(working);
		if (!workingRoot) return null;
		const byId = new Map(safeArray(plan.repairable).map((item) => [String(item.id), item]));
		const applied = [];
		for (const node of safeArray(workingRoot.nodes)) {
			const item = byId.get(String(node?.id));
			if (!item) continue;
			const candidate = candidateFromRepairItem(item, node);
			if (!candidate) continue;
			applySerializedReplacement(workingRoot, node, candidate);
			applied.push({
				id: node.id,
				oldType: item.oldType,
				newType: item.newType,
				display: item.display,
				reason: item.reason,
			});
		}
		return applied.length ? { workflow: working, applied } : null;
	}

	function buildSingleNodeReplacementWorkflow(plan, item, candidateItem) {
		const source = plan?.sourceWorkflow;
		const root = graphRoot(source);
		const type = compactText(candidateItem?.type);
		const nodeCtor = registry()[type];
		if (!root || !type || !nodeCtor) return null;
		const working = cloneWorkflow(source);
		const workingRoot = graphRoot(working);
		const node = safeArray(workingRoot?.nodes).find((candidate) => String(candidate?.id) === String(item?.id));
		if (!workingRoot || !node) return null;
		const candidate = candidateMatchForNode(node, {
			type,
			nodeCtor,
			names: nodeDisplayNames(type, nodeCtor),
		});
		if (!candidate) return null;
		const oldType = compactText(node?.type || item?.type);
		applySerializedReplacement(workingRoot, node, candidate);
		return {
			workflow: working,
			applied: [{
				id: node.id,
				oldType,
				newType: candidate.type,
				display: candidate.info?.display || candidateItem?.display || candidate.type,
				reason: candidateItem?.reason || candidate.reason || "手动选择备选节点",
			}],
		};
	}

	function confirmNodeReplacement(item, candidateItem) {
		const display = candidateItem?.display && candidateItem.display !== candidateItem.type ? ` / ${candidateItem.display}` : "";
		const message = [
			"将用这个备选节点替换当前缺失节点：",
			"",
			`缺失节点：#${item?.id} ${item?.type}`,
			`备选节点：${candidateItem?.type}${display}`,
			candidateItem?.reason ? `原因：${candidateItem.reason}` : "",
			Number.isFinite(Number(candidateItem?.score)) ? `相似度：${Math.round(Number(candidateItem.score) * 100)}%` : "",
			"",
			"替换后会重新加载当前工作流，是否继续？",
		].filter((line) => line !== "").join("\n");
		try {
			return window.confirm(message);
		} catch (_) {
			return false;
		}
	}

	async function runSingleNodeReplacement(item, candidateItem) {
		if (!confirmNodeReplacement(item, candidateItem)) {
			showToast("已取消替换。");
			return;
		}
		const built = buildSingleNodeReplacementWorkflow(lastPlan, item, candidateItem);
		if (!built?.workflow || !built.applied.length) {
			showToast("节点替换失败：没有找到可用的备选节点。");
			return;
		}
		const loader = originalLoadGraphData || app?.loadGraphData;
		if (typeof loader !== "function") {
			showToast("节点替换失败：当前前端没有可用的工作流加载接口。");
			return;
		}
		try {
			const result = loader.call(app, built.workflow);
			if (result && typeof result.then === "function") await result;
			const next = prepareWorkflowRepair(built.workflow);
			next.appliedReplacements = built.applied;
			scheduleNotice(next);
			showToast(`已替换节点：${built.applied[0].oldType} -> ${built.applied[0].newType}`, "ok");
		} catch (error) {
			console.warn("[GJJ] 备选节点替换失败:", error);
			const next = prepareWorkflowRepair(built.workflow);
			next.appliedReplacements = built.applied;
			next.error = compactText(error?.message || error);
			scheduleNotice(next);
			showToast(`节点替换失败：${compactText(error?.message || error)}`);
		}
	}

	function unresolvedNodeRow(item) {
		const candidates = item.candidates?.length
			? safeArray(item.candidates).map((candidate) => ({ ...candidate, source: "建议节点" }))
			: safeArray(item.systemCandidates).map((candidate) => ({ ...candidate, source: "系统相近节点" }));
		const wrap = row(
			`#${item.id} ${item.type}`,
			candidates.length ? "" : "暂无备选节点。",
			candidates.length ? "warn" : "bad",
			{
				copyText: item.type,
				copyLabel: "复制注册名",
				copyTitle: "复制缺失节点注册名",
				copyMessage: "已复制缺失节点注册名。",
			},
		);
		if (!candidates.length) return wrap;

		const list = document.createElement("div");
		list.className = "gjj-repair-node-list";
		for (const [index, candidate] of candidates.entries()) {
			const line = document.createElement("div");
			line.className = "gjj-repair-node-candidate";
			const info = document.createElement("div");
			const name = document.createElement("div");
			name.className = "gjj-repair-node-name";
			const display = candidate.display && candidate.display !== candidate.type ? ` / ${candidate.display}` : "";
			name.textContent = `${index + 1}. ${candidate.type}${display}`;
			const meta = document.createElement("div");
			meta.className = "gjj-repair-node-meta";
			const parts = [candidate.source];
			if (Number.isFinite(Number(candidate.score))) parts.push(`相似度 ${Math.round(Number(candidate.score) * 100)}%`);
			if (candidate.reason) parts.push(candidate.reason);
			meta.textContent = parts.join("，");
			info.append(name, meta);

			const replace = document.createElement("button");
			replace.type = "button";
			replace.className = "gjj-repair-replace";
			replace.textContent = "替换";
			replace.title = `用这个备选节点替换\n${candidate.type}`;
			replace.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				runSingleNodeReplacement(item, candidate);
			});
			line.append(info, replace);
			list.appendChild(line);
		}
		wrap.appendChild(list);
		return wrap;
	}

	function missingResourceRow(item) {
		const title = item.title ? ` / ${item.title}` : "";
		return row(
			`#${item.id} ${item.resource}${title}`,
			"资源文件或工作流内嵌资源缺失；请重新选择图片/资源文件，或把原资源补回后点击“复查”。",
			"bad",
			{
				copyText: item.resource,
				copyLabel: "复制资源ID",
				copyTitle: "复制缺失资源标识",
				copyMessage: "已复制缺失资源标识。",
			},
		);
	}

	async function runNodeRepair() {
		const built = buildNodeRepairWorkflow(lastPlan);
		if (!built?.workflow || !built.applied.length) {
			showToast("没有找到参数一致、可一键修复的缺失节点。");
			return;
		}
		const loader = originalLoadGraphData || app?.loadGraphData;
		if (typeof loader !== "function") {
			showToast("节点修复失败：当前前端没有可用的工作流加载接口。");
			return;
		}
		try {
			const result = loader.call(app, built.workflow);
			if (result && typeof result.then === "function") await result;
			const next = prepareWorkflowRepair(built.workflow);
			next.appliedReplacements = built.applied;
			scheduleNotice(next);
			showToast(`已按按钮修复 ${built.applied.length} 个缺失节点。`, "ok");
		} catch (error) {
			console.warn("[GJJ] 节点修复失败:", error);
			showToast(`节点修复失败：${compactText(error?.message || error)}`);
			const next = prepareWorkflowRepair(built.workflow);
			next.appliedReplacements = built.applied;
			next.error = compactText(error?.message || error);
			scheduleNotice(next);
		}
	}

	function renderNotice(plan, options = {}) {
		lastPlan = plan || emptyPlan();
		lastModelNodes = missingModelNodes();
		const modelCount = missingModelWidgetCount(lastModelNodes);
		if (!options.skipModelScan) {
			scheduleModelSuggestionScan(modelCount ? lastModelNodes : []);
		}
		const repairableCount = safeArray(lastPlan.repairable).length;
		const appliedCount = safeArray(lastPlan.appliedReplacements).length;
		const unresolvedCount = safeArray(lastPlan.unresolved).length;
		const resourceCount = safeArray(lastPlan.missingResources).length;
		if (!modelCount && !repairableCount && !appliedCount && !unresolvedCount && !resourceCount && !lastPlan.error) {
			if (panel) panel.style.display = "none";
			return;
		}

		const root = ensurePanel();
		root.replaceChildren();
		root.style.display = "flex";

		const head = document.createElement("div");
		head.className = "gjj-repair-head";
		const title = document.createElement("div");
		title.className = "gjj-repair-title";
		title.textContent = "🩹 GJJ修复";
		const summary = document.createElement("div");
		summary.className = "gjj-repair-summary";
		summary.textContent = [
			modelCount ? `缺失模型 ${modelCount}` : "",
			resourceCount ? `缺失资源 ${resourceCount}` : "",
			repairableCount ? `可修复节点 ${repairableCount}` : "",
			appliedCount ? `已修复节点 ${appliedCount}` : "",
			unresolvedCount ? `待确认节点 ${unresolvedCount}` : "",
			lastPlan.error ? "加载有提示" : "",
		].filter(Boolean).join(" / ") || "没有发现问题";

		const copy = document.createElement("button");
		copy.type = "button";
		copy.textContent = "⧉";
		copy.title = "复制修复建议";
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard?.writeText(copyNoticeText(lastPlan, modelCount, lastModelSuggestions));
				showToast("已复制工作流修复建议。", "ok");
			} catch (_) {
				showToast("复制失败，请查看控制台输出。");
				console.log(copyNoticeText(lastPlan, modelCount, lastModelSuggestions));
			}
		});

		const close = document.createElement("button");
		close.type = "button";
		close.textContent = "×";
		close.title = "关闭";
		close.addEventListener("click", () => {
			root.style.display = "none";
		});
		head.append(title, summary, copy, close);
		root.appendChild(head);

		const body = document.createElement("div");
		body.className = "gjj-repair-body";
		const actions = document.createElement("div");
		actions.className = "gjj-repair-actions";
		const summon = document.createElement("button");
		summon.type = "button";
		summon.textContent = "🧲 召唤模型";
		summon.disabled = !modelCount || !summonApi()?.summonModelsForNodes;
		summon.title = "使用 GJJ 召唤模型逻辑匹配本地模型文件";
		summon.addEventListener("click", () => runSummonModelRepair());
		const repairNodes = document.createElement("button");
		repairNodes.type = "button";
		repairNodes.textContent = "🔧 修复节点";
		repairNodes.disabled = !repairableCount;
		repairNodes.title = "只替换名称和接口都匹配的缺失节点";
		repairNodes.addEventListener("click", () => runNodeRepair());
		const rescan = document.createElement("button");
		rescan.type = "button";
		rescan.textContent = "↻ 复查";
		rescan.title = "重新扫描当前工作流";
		rescan.addEventListener("click", () => renderNotice(lastPlan));
		actions.append(summon, repairNodes, rescan);
		body.appendChild(actions);

		if (modelCount) {
			const modelRows = [];
			if (lastModelSuggestions.length) {
				for (const item of lastModelSuggestions) {
					modelRows.push(modelSuggestionRow(item));
				}
			} else if (modelSuggestionError) {
				modelRows.push(row(`找到 ${modelCount} 个缺失模型入口`, `候选扫描失败：${modelSuggestionError}`, "bad"));
			} else if (modelSuggestionReadyKey === modelSuggestionKey) {
				modelRows.push(row(`找到 ${modelCount} 个缺失模型入口`, "暂无可按相似度排序的本地候选。", "warn"));
			} else {
				modelRows.push(row(`找到 ${modelCount} 个缺失模型入口`, "正在按相似度扫描本地候选；点击“召唤模型”后才会替换。", "warn"));
			}
			body.appendChild(section("缺失模型候选", modelRows));
		}

		if (resourceCount) {
			body.appendChild(section("缺失资源", safeArray(lastPlan.missingResources).map((item) => missingResourceRow(item))));
		}

		if (repairableCount) {
			body.appendChild(section("可一键修复节点", safeArray(lastPlan.repairable).map((item) => (
				row(
					`#${item.id} ${item.oldType} -> ${item.newType}`,
					`参数一致，点击“修复节点”后才替换。${item.reason ? ` ${item.reason}` : ""}`,
					"ok",
					{
						copyText: item.oldType,
						copyLabel: "复制注册名",
						copyTitle: "复制缺失节点注册名",
						copyMessage: "已复制缺失节点注册名。",
					},
				)
			))));
		}

		if (appliedCount) {
			body.appendChild(section("已修复节点", safeArray(lastPlan.appliedReplacements).map((item) => (
				row(`#${item.id} ${item.oldType} -> ${item.newType}`, item.reason, "ok")
			))));
		}

		if (unresolvedCount) {
			const rows = [];
			for (const item of safeArray(lastPlan.unresolved)) {
				rows.push(unresolvedNodeRow(item));
			}
			body.appendChild(section("缺失节点建议", rows));
		}

		if (lastPlan.error) {
			body.appendChild(section("加载提示", [row(lastPlan.error, "如果默认错误窗口仍显示，可以先看这里的替换建议。", "bad")]));
		}

		root.appendChild(body);
	}

	function scheduleNotice(plan, error = null) {
		const next = plan || emptyPlan();
		if (error) next.error = compactText(error?.message || error);
		clearTimeout(rescanTimer);
		rescanTimer = setTimeout(() => renderNotice(next), 420);
	}

	function patchLoadGraphData() {
		if (!app || app[PATCH_FLAG] || typeof app.loadGraphData !== "function") return;
		app[PATCH_FLAG] = true;
		const original = app.loadGraphData;
		originalLoadGraphData = original;
		app.loadGraphData = function (graphData, ...rest) {
			let plan = emptyPlan();
			try {
				plan = prepareWorkflowRepair(graphData);
				if (plan.repairable.length || plan.unresolved.length) {
					console.log("[GJJ] 工作流修复：发现缺失节点，等待用户点击修复。", {
						repairable: plan.repairable,
						unresolved: plan.unresolved,
					});
				}
			} catch (error) {
				console.warn("[GJJ] 工作流修复预检查失败:", error);
				plan.error = compactText(error?.message || error);
			}

			try {
				const result = original.call(this, graphData, ...rest);
				if (result && typeof result.then === "function") {
					return result.then((value) => {
						scheduleNotice(plan);
						return value;
					}).catch((error) => {
						scheduleNotice(plan, error);
						throw error;
					});
				}
				scheduleNotice(plan);
				return result;
			} catch (error) {
				scheduleNotice(plan, error);
				throw error;
			}
		};
	}

	function scanCurrentWorkflow() {
		let data = null;
		try {
			data = app?.graph?.serialize?.();
		} catch (_) {
			data = null;
		}
		const plan = prepareWorkflowRepair(data);
		renderNotice(plan);
		return plan;
	}

	globalThis.GJJ_WorkflowRepairNotice = {
		rescan: scanCurrentWorkflow,
		show: () => renderNotice(lastPlan || emptyPlan()),
	};

	app.registerExtension({
		name: EXTENSION_NAME,
		setup() {
			patchLoadGraphData();
			console.log("[GJJ] 工作流修复通知已启用");
		},
	});
})();

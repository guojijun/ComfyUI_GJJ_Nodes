import { app } from "/scripts/app.js";

// 这里统一增强批量图相关插槽的拖线推荐/搜索体验，让高频入口优先出现。
const LAZY_IMAGE_STUDIO_CLASS = "GJJ_LazyImageStudio";
const WAN_RAPID_AIO_MEGA_CLASS = "GJJ_Wan22RapidAIOMega";
const LORA_FACE_MATERIAL_CLASS = "GJJ_LoraFaceMaterialGenerator";
const VIDEO_COMBINE_CLASS = "GJJ_VideoCombine";
const COMPREHENSIVE_MATTING_CLASS = "GJJ_ComprehensiveMatting";
const MULTI_IMAGE_LOADER_CLASS = "GJJ_MultiImageLoader";
const BATCH_IMAGE_PREVIEW_CLASS = "guojijun_BatchImagePreview";

const LAZY_BATCH_INPUT_NAME = "image_01";
const WAN_BATCH_INPUT_NAME = "images";
const LORA_FACE_BATCH_INPUT_NAME = "reference_batch";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const MIXED_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const WAN_OUTPUT_NAME = "视频帧序列";

const LOADER_SEARCH_TEXT = "多图片加载预览器";
const VIDEO_COMBINE_SEARCH_TEXT = "视频合成器";
const MATTING_SEARCH_TEXT = "综合抠图";

function prependDefaultNode(map, slotType, nodeName) {
	if (!map || !slotType || !nodeName) {
		return;
	}
	const existing = map[slotType];
	const list = Array.isArray(existing)
		? [...existing]
		: (existing ? [existing] : []);
	const filtered = list.filter((item) => {
		const name = typeof item === "string" ? item : String(item?.node || "");
		return name !== nodeName;
	});
	map[slotType] = [nodeName, ...filtered];
}

function promoteMultiImageLoaderDefaults() {
	if (!globalThis.LiteGraph) {
		return;
	}
	const outDefaults = LiteGraph.slot_types_default_out;
	const inDefaults = LiteGraph.slot_types_default_in;
	prependDefaultNode(outDefaults, "IMAGE", MULTI_IMAGE_LOADER_CLASS);
	prependDefaultNode(outDefaults, BATCH_IMAGE_TYPE, MULTI_IMAGE_LOADER_CLASS);
	prependDefaultNode(outDefaults, MIXED_BATCH_IMAGE_TYPE, MULTI_IMAGE_LOADER_CLASS);
	prependDefaultNode(inDefaults, BATCH_IMAGE_TYPE, BATCH_IMAGE_PREVIEW_CLASS);
	prependDefaultNode(inDefaults, MIXED_BATCH_IMAGE_TYPE, BATCH_IMAGE_PREVIEW_CLASS);
}

function getNodeClassName(node) {
	return String(node?.comfyClass || node?.type || "");
}

function resolveSlotRef(node, slotRef, isOutput) {
	const list = isOutput ? node?.outputs : node?.inputs;
	if (!Array.isArray(list)) {
		return { slot: null, index: -1 };
	}

	if (typeof slotRef === "number") {
		return {
			slot: list[slotRef] || null,
			index: Number.isInteger(slotRef) ? slotRef : -1,
		};
	}

	if (typeof slotRef === "string") {
		const index = isOutput
			? node.findOutputSlot?.(slotRef, false)
			: node.findInputSlot?.(slotRef, false);
		return {
			slot: index >= 0 ? list[index] || null : null,
			index: index >= 0 ? index : -1,
		};
	}

	const slot = slotRef || null;
	const index = slot
		? (isOutput ? node.findOutputSlot?.(slot.name, false) : node.findInputSlot?.(slot.name, false))
		: -1;
	return {
		slot,
		index: index >= 0 ? index : -1,
	};
}

function resolvePreferredSearchText(options = {}) {
	const isFrom = options?.nodeFrom && options?.slotFrom != null;
	if (isFrom && getNodeClassName(options.nodeFrom) === WAN_RAPID_AIO_MEGA_CLASS) {
		const { slot } = resolveSlotRef(options.nodeFrom, options.slotFrom, true);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === WAN_OUTPUT_NAME || slotType === BATCH_IMAGE_TYPE) {
			return VIDEO_COMBINE_SEARCH_TEXT;
		}
	}

	const isTo = options?.nodeTo && options?.slotTo != null;
	if (isTo && getNodeClassName(options.nodeTo) === LAZY_IMAGE_STUDIO_CLASS) {
		const { slot } = resolveSlotRef(options.nodeTo, options.slotTo, false);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === LAZY_BATCH_INPUT_NAME || slotType === BATCH_IMAGE_TYPE) {
			return LOADER_SEARCH_TEXT;
		}
	}

	if (isTo && getNodeClassName(options.nodeTo) === WAN_RAPID_AIO_MEGA_CLASS) {
		const { slot } = resolveSlotRef(options.nodeTo, options.slotTo, false);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === WAN_BATCH_INPUT_NAME || slotType === BATCH_IMAGE_TYPE) {
			return LOADER_SEARCH_TEXT;
		}
	}

	if (isTo && getNodeClassName(options.nodeTo) === LORA_FACE_MATERIAL_CLASS) {
		const { slot } = resolveSlotRef(options.nodeTo, options.slotTo, false);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === LORA_FACE_BATCH_INPUT_NAME || slotType === BATCH_IMAGE_TYPE) {
			return LOADER_SEARCH_TEXT;
		}
	}

	if (isTo && getNodeClassName(options.nodeTo) === VIDEO_COMBINE_CLASS) {
		const { slot } = resolveSlotRef(options.nodeTo, options.slotTo, false);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === "images" || slotType === BATCH_IMAGE_TYPE) {
			return VIDEO_COMBINE_SEARCH_TEXT;
		}
	}

	if (isTo && getNodeClassName(options.nodeTo) === COMPREHENSIVE_MATTING_CLASS) {
		const { slot } = resolveSlotRef(options.nodeTo, options.slotTo, false);
		const slotName = String(slot?.name || "");
		const slotType = String(slot?.type || "*");
		if (slotName === "batch_image" || slotType === BATCH_IMAGE_TYPE) {
			return LOADER_SEARCH_TEXT;
		}
	}

	if (isFrom && getNodeClassName(options.nodeFrom) === COMPREHENSIVE_MATTING_CLASS) {
		const { slot } = resolveSlotRef(options.nodeFrom, options.slotFrom, true);
		const slotType = String(slot?.type || "*");
		if (slotType === BATCH_IMAGE_TYPE) {
			return VIDEO_COMBINE_SEARCH_TEXT;
		}
	}

	if (isFrom && getNodeClassName(options.nodeFrom) === MULTI_IMAGE_LOADER_CLASS) {
		const { slot } = resolveSlotRef(options.nodeFrom, options.slotFrom, true);
		const slotType = String(slot?.type || "*");
		if (slotType === BATCH_IMAGE_TYPE) {
			return "";
		}
	}

	return "";
}

function primeSearchBox(searchText) {
	if (!searchText) {
		return;
	}

	requestAnimationFrame(() => {
		const inputs = [...document.querySelectorAll('input[placeholder*="添加节点"], input[placeholder*="Add"]')];
		const input = inputs.at(-1);
		if (!input || String(input.value || "").trim()) {
			return;
		}
		input.value = String(searchText);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.select?.();
	});
}

function extractSearchOptions(args) {
	for (const value of args || []) {
		if (!value || typeof value !== "object") {
			continue;
		}
		if ("node_from" in value || "node_to" in value || "slot_from" in value || "slot_to" in value) {
			return value;
		}
	}
	return {};
}

app.registerExtension({
	name: "GJJ.BatchImageSearchHints",
	setup() {
		promoteMultiImageLoaderDefaults();
		if (window.__gjjBatchImageSearchHintsPatched) {
			return;
		}
		window.__gjjBatchImageSearchHintsPatched = true;

		const originalShowSearchBox = LGraphCanvas.prototype.showSearchBox;
		if (typeof originalShowSearchBox !== "function") {
			return;
		}

		LGraphCanvas.prototype.showSearchBox = function (...args) {
			const options = extractSearchOptions(args);
			const searchText = resolvePreferredSearchText({
				nodeFrom: options.node_from || null,
				slotFrom: options.slot_from ?? null,
				nodeTo: options.node_to || null,
				slotTo: options.slot_to ?? options.slot_from ?? null,
			});
			const result = originalShowSearchBox.apply(this, args);
			primeSearchBox(searchText);
			return result;
		};
	},
});

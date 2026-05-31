import { api } from "/scripts/api.js";

const PRESET_TABLE_API_URL = "/gjj/model_family_presets";

const LIST_FIELDS = new Set(["keywords", "clip_names"]);
const INT_FIELDS = new Set(["steps", "base_steps", "main_long_edge", "vl_long_edge", "width", "height"]);
const FLOAT_FIELDS = new Set(["lora_1_strength", "lora_2_strength", "cfg", "denoise", "model_shift", "cfg_norm_strength"]);
const BOOL_FIELDS = new Set(["supports_multi_image_edit"]);
const IGNORED_MODEL_TOKENS = new Set([
	"fp8", "fp16", "fp32", "bf16", "float8", "float16", "float32",
	"e4m3fn", "e5m2", "scaled", "fast", "mixed", "nvfp4", "mxfp4",
	"q2", "q3", "q4", "q5", "q6", "q8", "q8_0", "q4_0", "q4_1", "q5_0", "q5_1",
]);

let presetCache = [];
let presetPromise = null;

function normalizeLookupText(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/\.(safetensors|ckpt|pt|pth|bin|sft|gguf)$/i, "")
		.split(/[^a-z0-9]+/i)
		.filter((token) => token && !IGNORED_MODEL_TOKENS.has(token) && !/^v\d+(?:\d+|\.\d+)*$/.test(token))
		.join("");
}

function parseScalar(key, value) {
	const text = String(value || "").trim();
	if (!text) {
		return undefined;
	}
	if (INT_FIELDS.has(key)) {
		return Number.parseInt(text, 10);
	}
	if (FLOAT_FIELDS.has(key)) {
		return Number.parseFloat(text);
	}
	if (BOOL_FIELDS.has(key)) {
		return ["1", "true", "yes", "on"].includes(text.toLowerCase());
	}
	return text;
}

function toJsPreset(row) {
	const preset = {};
	for (const [key, raw] of Object.entries(row)) {
		if (LIST_FIELDS.has(key)) {
			preset[key] = Array.isArray(raw)
				? raw.map(String).map((item) => item.trim()).filter(Boolean)
				: String(raw || "").split("|").map((item) => item.trim()).filter(Boolean);
			continue;
		}
		const value = parseScalar(key, raw);
		if (value !== undefined) {
			preset[key] = value;
		}
	}
	return {
		id: preset.id || "",
		keywords: preset.keywords || [],
		modelName: preset.model_name || "",
		modelCategory: preset.model_category || "",
		clipType: preset.clip_type || "stable_diffusion",
		clipNames: preset.clip_names || [],
		vaeName: preset.vae_name || "",
		modelPatchName: preset.model_patch_name || "",
		clipVisionName: preset.clip_vision_name || "",
		lora1: preset.lora_1_name || "",
		lora1Strength: preset.lora_1_strength ?? 0.0,
		lora2: preset.lora_2_name || "",
		lora2Strength: preset.lora_2_strength ?? 0.0,
		steps: preset.steps ?? 20,
		baseSteps: preset.base_steps,
		cfg: preset.cfg ?? 1.0,
		sampler: preset.sampler_name || "euler",
		scheduler: preset.scheduler || "normal",
		denoise: preset.denoise ?? 1.0,
		modelSampling: preset.model_sampling || "",
		modelShift: preset.model_shift ?? 0.0,
		cfgNormStrength: preset.cfg_norm_strength ?? 0.0,
		supportsMultiImageEdit: Boolean(preset.supports_multi_image_edit),
		mainLongEdge: preset.main_long_edge ?? 1024,
		vlLongEdge: preset.vl_long_edge ?? 512,
		width: preset.width ?? 1024,
		height: preset.height ?? 1024,
	};
}

function parsePresetTable(text) {
	const lines = String(text || "")
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed.length && !trimmed.startsWith("#");
		});
	if (lines.length < 2) {
		return [];
	}
	const headerIndex = lines.findIndex((line) => {
		const parts = line.split("\t").map((item) => item.trim());
		return parts.length >= 2 && parts[0] === "id" && parts[1] === "keywords";
	});
	if (headerIndex < 0 || headerIndex >= lines.length - 1) {
		return [];
	}
	const headers = lines[headerIndex].split("\t").map((item) => item.trim());
	return lines.slice(headerIndex + 1).map((line) => {
		const columns = line.split("\t");
		const row = {};
		headers.forEach((header, index) => {
			row[header] = columns[index] ?? "";
		});
		return toJsPreset(row);
	});
}

export function getCachedModelFamilyPresets() {
	return presetCache;
}

export function matchModelFamilyPreset(unetName, presets = presetCache) {
	const normalizedUnet = normalizeLookupText(unetName);
	if (!normalizedUnet) {
		return null;
	}
	let best = null;
	let bestLength = -1;
	for (const preset of presets || []) {
		for (const keyword of preset.keywords || []) {
			const normalizedKeyword = normalizeLookupText(keyword);
			if (normalizedKeyword && normalizedUnet.includes(normalizedKeyword) && normalizedKeyword.length > bestLength) {
				best = preset;
				bestLength = normalizedKeyword.length;
			}
		}
	}
	return best;
}

export async function getModelFamilyPresets() {
	if (presetPromise) {
		return presetPromise;
	}
	presetPromise = api.fetchApi(PRESET_TABLE_API_URL)
		.then((response) => {
			if (!response.ok) {
				throw new Error(`Failed to load model family preset table: ${response.status}`);
			}
			return response.json();
		})
		.then((payload) => {
			const presets = Array.isArray(payload?.presets) ? payload.presets : [];
			presetCache = presets.map((row) => toJsPreset(row));
			return presetCache;
		})
		.catch((error) => {
			console.warn("[GJJ] Failed to load model family preset table", error);
			presetCache = [];
			return presetCache;
		});
	return presetPromise;
}

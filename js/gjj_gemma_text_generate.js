import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { gjjCharacterThumbnailPath, gjjSceneThumbnailPath, loadGjjLibraryThumbnailBlobUrl, setGjjLibraryThumbnail } from "./gjj_library_thumbnails.js";

const NODE_TYPE = "GJJ_GemmaTextGenerate";
const NODE_TITLE_PREFIX = "GJJ·💛Gemma🧠";
const NODE_TITLE_SUFFIX = " 图片反推提示词推理";
const PANEL_WIDGET = "gjj_gemma_text_generate_panel";
const RESULT_WIDGET = "gjj_gemma_text_generate_result";
const PROMPT_WIDGET = "prompt";
const EXTERNAL_PROMPT_INPUT = "external_prompt";
const TEMPLATE_WIDGET = "system_prompt_templates";
const OUTPUT_RULE_WIDGET = "system_prompt_output_rule";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "ollama_assistant";
const WORKFLOW_VALUES_PROPERTY = "gjj_gemma_text_generate_values";
const WORKFLOW_VALUES_WIDGET = "workflow_values_json";
const MODEL_FILTER_WIDGET = "model_filter_keywords";
const MODEL_SIZES_ENDPOINT = "/gjj/text_encoder_model_sizes";
const CHARACTER_LIBRARY_ENDPOINT = "/gjj/character_library/list";
const SCENE_LIBRARY_ENDPOINT = "/gjj/scene_library/thumbnail_index";
const ACTORS_PROPERTY = "gjj_gemma_text_generate_actors";
const ACTOR_PREFIXES_PROPERTY = "gjj_gemma_text_generate_actor_prefixes";
const SCENES_PROPERTY = "gjj_gemma_text_generate_scenes";
const CLIP_TYPE_REFERENCE_MIGRATION = "gjj_text_generate_clip_type_reference_v1";
const MEDIA_INPUT = "media";
const MEDIA_INPUT_TYPE = "IMAGE,GJJ_BATCH_IMAGE,VIDEO,AUDIO";
const PROMPT_HEIGHT = 74;
const NODE_EXTRA_HEIGHT = 78;
const LEGACY_LYRICS_TEMPLATE = "根据用户输入内容匹配对应的中文歌曲，只纯输出歌曲完整中文歌词。";
const ORIGINAL_LYRICS_TEMPLATE = "根据用户输入的主题、情绪和画面创作一首全新的原创中文歌曲歌词。不得查找、引用、改写或复现任何现有歌曲及其歌词；直接创作完整歌词，只输出歌词正文，不输出歌名、歌手、解释、分析或提示语。";
const LEGACY_MEDIA_INPUTS = new Set(["image", "video", "图像", "视频帧", "媒体", "图片/视频"]);
const AUDIO_INPUT = "audio";
const HIDDEN_WIDGETS = new Set([
	"clip_name",
	"clip_type",
	"clip_device",
	"max_length",
	"sampling_mode",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
	"thinking",
	"use_default_template",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
	"keep_model",
	"device_preference",
	WORKFLOW_VALUES_WIDGET,
	MODEL_FILTER_WIDGET,
]);
const BACKEND_WIDGETS = [
	"clip_name",
	"clip_type",
	"clip_device",
	PROMPT_WIDGET,
	"max_length",
	"sampling_mode",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
	"thinking",
	"use_default_template",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
	"keep_model",
	"device_preference",
	WORKFLOW_VALUES_WIDGET,
	MODEL_FILTER_WIDGET,
];
const STATE_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== WORKFLOW_VALUES_WIDGET);
const REORDERED_WIDGETS = [
	PROMPT_WIDGET,
	...BACKEND_WIDGETS.filter((name) => name !== PROMPT_WIDGET),
];
const NUMERIC_WIDGETS = new Set([
	"max_length",
	"temperature",
	"top_k",
	"top_p",
	"min_p",
	"repetition_penalty",
	"seed",
	"presence_penalty",
]);
const NUMERIC_DEFAULTS = {
	max_length: 512,
	temperature: 0.7,
	top_k: 64,
	top_p: 0.95,
	min_p: 0.05,
	repetition_penalty: 1.05,
	seed: 0,
	presence_penalty: 0,
};
let sharedSettingsPromise = null;
let modelSizesPromise = null;
let characterSummariesPromise = null;
let activeFloatingPreview = null;

function closeFloatingPreview(owner = null) {
	if (!activeFloatingPreview || (owner && activeFloatingPreview.owner !== owner)) return;
	activeFloatingPreview.element.remove();
	if (activeFloatingPreview.owner) activeFloatingPreview.owner.__gjjActorPreview = null;
	activeFloatingPreview = null;
}

function showFloatingPreview(owner, imageUrl, captionText) {
	closeFloatingPreview();
	if (!owner || !imageUrl) return;
	const preview = document.createElement("div");
	preview.className = "gjj-gemma-actor-preview";
	const large = document.createElement("img");
	const thumbnailKind = String(imageUrl).includes("/scene_library/") ? "scene" : "character";
	const thumbnailId = decodeURIComponent(String(imageUrl).split("/").pop()?.replace(/\.(?:png|jpg)(?:\?.*)?$/i, "") || "");
	void loadGjjLibraryThumbnailBlobUrl(api, thumbnailKind, thumbnailId).then((blobUrl) => {
		large.src = blobUrl || (api.apiURL ? api.apiURL(imageUrl) : imageUrl);
	});
	const caption = document.createElement("div");
	caption.textContent = captionText;
	preview.append(large, caption);
	document.body.appendChild(preview);
	const rect = owner.getBoundingClientRect();
	preview.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, rect.right + 8))}px`;
	preview.style.top = `${Math.max(8, Math.min(window.innerHeight - 390, rect.top))}px`;
	owner.__gjjActorPreview = preview;
	activeFloatingPreview = { owner, element: preview };
}

window.addEventListener("blur", () => closeFloatingPreview());
document.addEventListener("visibilitychange", () => {
	if (document.hidden) closeFloatingPreview();
});
globalThis.addEventListener("gjj_character_library_updated", () => {
	characterSummariesPromise = null;
	for (const node of app.graph?._nodes || []) {
		if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) continue;
		renderActorChips(node);
		syncActorMentionMenu(node);
	}
});
globalThis.addEventListener("gjj_scene_library_updated", () => {
	for (const node of app.graph?._nodes || []) {
		if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) continue;
		renderSceneChips(node);
	}
});
document.addEventListener("pointerdown", (event) => {
	if (activeFloatingPreview && !activeFloatingPreview.owner?.contains(event.target)) closeFloatingPreview();
	for (const node of app.graph?._nodes || []) {
		if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) continue;
		const state = node?.__gjjGemmaPanel;
		if (!state?.actorMentionMenu) continue;
		if (state.actorMentionMenu.contains(event.target) || state.promptEditor?.contains(event.target)) continue;
		closeActorMentionMenu(node);
	}
}, true);

function loadModelSizes() {
	if (!modelSizesPromise) {
		modelSizesPromise = api.fetchApi(MODEL_SIZES_ENDPOINT)
			.then((response) => response.ok ? response.json() : {})
			.then((data) => data?.sizes || {})
			.catch(() => ({}));
	}
	return modelSizesPromise;
}

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function widgetValue(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function syncNodeTitle(node) {
	const model = String(widgetValue(node, "clip_name", "") || "")
		.replaceAll("\\", "/").split("/").pop()
		.replace(/\.(?:safetensors|gguf|bin|pt|pth|ckpt)$/i, "");
	node.title = `${NODE_TITLE_PREFIX}${model || "未选择模型"}${NODE_TITLE_SUFFIX}`;
}

function protect(element) {
	if (!element || element.__gjjGemmaProtected) return element;
	element.__gjjGemmaProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

function prioritizeIconImage(image) {
	if (!image) return image;
	image.loading = "eager";
	image.fetchPriority = "high";
	image.decoding = "sync";
	return image;
}

function markChanged(node) {
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
}

function setWidgetValue(node, name, value) {
	const target = widget(node, name);
	if (!target) return;
	target.value = value;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = value;
	if (target.element && "value" in target.element) target.element.value = value;
	target.callback?.(value, app.canvas, node, undefined, target);
	markChanged(node);
}

function characterDisplayName(character) {
	return String(character?.name || character?.id || "未命名角色").replace(/^\s*(?:♀️|♂️|♀|♂)\s*/, "").trim();
}

function actorPromptLine(character) {
	return `@${characterDisplayName(character)}`;
}

function characterCover(character) {
	return gjjCharacterThumbnailPath(character);
}

function appendReferenceToPrompt(node, reference) {
	const current = String(widgetValue(node, PROMPT_WIDGET, "") || "").trimEnd();
	const value = String(reference || "").trim();
	if (!value) return;
	setWidgetValue(node, PROMPT_WIDGET, current ? `${current} ${value}` : value);
}

function sceneDisplayName(scene) {
	return String(scene?.name || scene?.id || "未命名场景").trim();
}

function sceneCover(scene) {
	return gjjSceneThumbnailPath(scene);
}

function selectedScenes(node) {
	const scenes = node?.properties?.[SCENES_PROPERTY];
	return Array.isArray(scenes) ? scenes.filter((item) => item && item.id) : [];
}

function saveScenes(node, scenes) {
	node.properties ||= {};
	node.properties[SCENES_PROPERTY] = scenes.map((item) => ({
		id: String(item.id),
		name: sceneDisplayName(item),
		notes: String(item.notes || ""),
		thumbnail_url: sceneCover(item),
	}));
	markChanged(node);
	renderSceneChips(node);
}

function makeReferenceChipSortable(chip, items, index, kind, save) {
	chip.draggable = true;
	chip.title = `${chip.title || ""}；拖动可调整顺序`;
	const mime = `application/x-gjj-gemma-${kind}-index`;
	chip.addEventListener("dragstart", (event) => {
		event.stopPropagation();
		chip.classList.add("dragging");
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(mime, String(index));
	});
	chip.addEventListener("dragover", (event) => {
		if (!event.dataTransfer.types.includes(mime)) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		chip.classList.add("drag-over");
	});
	chip.addEventListener("dragleave", () => chip.classList.remove("drag-over"));
	chip.addEventListener("drop", (event) => {
		event.preventDefault();
		event.stopPropagation();
		chip.classList.remove("drag-over");
		const from = Number(event.dataTransfer.getData(mime));
		if (!Number.isInteger(from) || from < 0 || from >= items.length || from === index) return;
		const reordered = items.slice();
		const [moved] = reordered.splice(from, 1);
		reordered.splice(index, 0, moved);
		chip.__gjjJustDragged = true;
		save(reordered);
	});
	chip.addEventListener("dragend", () => {
		chip.classList.remove("dragging", "drag-over");
		setTimeout(() => { chip.__gjjJustDragged = false; }, 0);
	});
}

function renderSceneChips(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state?.sceneChips) return;
	const scenes = selectedScenes(node);
	state.sceneChips.replaceChildren();
	state.sceneChips.style.display = scenes.length ? "flex" : "none";
	for (const [index, scene] of scenes.entries()) {
		const sceneCoverUrl = sceneCover(scene);
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "gjj-gemma-actor-chip";
		chip.title = `${sceneDisplayName(scene)}${scene.notes ? `：${scene.notes}` : ""}；点击添加引用，Ctrl/Cmd+点击移除`;
		if (sceneCoverUrl) {
			const image = prioritizeIconImage(document.createElement("img"));
			setGjjLibraryThumbnail(image, api, "scene", scene);
			chip.appendChild(image);
		}
		const name = document.createElement("span");
		name.textContent = `🏕️${sceneDisplayName(scene)}`;
		chip.appendChild(name);
		chip.addEventListener("mouseenter", () => {
			if (!sceneCoverUrl) return;
			const notes = String(scene.notes || "").replace(/\s+/g, " ").trim();
			showFloatingPreview(chip, sceneCoverUrl, `🏕️${sceneDisplayName(scene)}${notes ? `（${notes}）` : ""}`);
		});
		chip.addEventListener("mouseleave", () => closeFloatingPreview(chip));
		chip.addEventListener("click", (event) => {
			if (chip.__gjjJustDragged) return;
			closeFloatingPreview(chip);
			event.preventDefault();
			event.stopPropagation();
			if (event.ctrlKey || event.metaKey) {
				saveScenes(node, scenes.filter((item) => String(item.id) !== String(scene.id)));
				return;
			}
			appendReferenceToPrompt(node, `🏕️${sceneDisplayName(scene)}`);
		});
		makeReferenceChipSortable(chip, scenes, index, "scene", (items) => saveScenes(node, items));
		state.sceneChips.appendChild(chip);
	}
}

function selectedActors(node) {
	const actors = node?.properties?.[ACTORS_PROPERTY];
	return Array.isArray(actors) ? actors.filter((item) => item && item.id) : [];
}

function saveActors(node, actors) {
	node.properties ||= {};
	node.properties[ACTORS_PROPERTY] = actors.map((item) => ({
		id: String(item.id),
		name: characterDisplayName(item),
		notes: String(item.notes || ""),
	}));
	node.properties[ACTOR_PREFIXES_PROPERTY] = actors.map(actorPromptLine);
	markChanged(node);
	renderActorChips(node);
}

function toggleActorSelection(node, character) {
	const actors = selectedActors(node);
	const existingIndex = actors.findIndex((actor) => String(actor.id) === String(character.id));
	if (existingIndex >= 0) {
		actors.splice(existingIndex, 1);
	} else {
		actors.push({
			id: String(character.id),
			name: characterDisplayName(character),
			notes: String(character.notes || ""),
		});
	}
	saveActors(node, actors);
}

function applyActorRangeSelection(node, characters, fromIndex, toIndex, additive) {
	if (!Array.isArray(characters) || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
	const start = Math.min(fromIndex, toIndex);
	const end = Math.max(fromIndex, toIndex) + 1;
	const range = characters.slice(start, end);
	if (additive) {
		const current = selectedActors(node);
		const existingIds = new Set(current.map((actor) => String(actor.id)));
		for (const character of range) {
			if (!existingIds.has(String(character.id))) {
				current.push({
					id: String(character.id),
					name: characterDisplayName(character),
					notes: String(character.notes || ""),
				});
			}
		}
		saveActors(node, current);
	} else {
		saveActors(node, range.map((character) => ({
			id: String(character.id),
			name: characterDisplayName(character),
			notes: String(character.notes || ""),
		})));
	}
}

function loadCharacterSummaries() {
	if (!characterSummariesPromise) {
		characterSummariesPromise = api.fetchApi(`${CHARACTER_LIBRARY_ENDPOINT}?summary=1`)
			.then(async (response) => {
				const data = await response.json();
				if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取角色库失败");
				return data;
			})
			.catch((error) => {
				characterSummariesPromise = null;
				throw error;
			});
	}
	return characterSummariesPromise;
}

function actorMentionRange(textarea) {
	const caret = Number(textarea?.selectionStart ?? 0);
	const before = String(textarea?.value || "").slice(0, caret);
	const match = before.match(/(^|[\s\n，。；：、,.!?;:()[\]{}"'“”‘’])@([^\s@，。；：、,.!?;:()[\]{}"'“”‘’]*)$/);
	if (!match) return null;
	return {
		start: before.length - match[2].length - 1,
		end: caret,
		query: match[2] || "",
	};
}

function closeActorMentionMenu(node) {
	const state = node?.__gjjGemmaPanel;
	state?.actorMentionMenu?.remove?.();
	if (state) {
		state.actorMentionMenu = null;
		state.actorMentionOptions = [];
		state.actorMentionActive = 0;
	}
}

function saveActorIfNeeded(node, character) {
	const actors = selectedActors(node);
	if (actors.some((actor) => String(actor.id) === String(character.id))) return;
	actors.push({
		id: String(character.id),
		name: characterDisplayName(character),
		notes: String(character.notes || ""),
	});
	saveActors(node, actors);
}

function chooseActorMention(node, character) {
	const state = node?.__gjjGemmaPanel;
	const editor = state?.promptEditor;
	const range = actorMentionRange(editor);
	if (!editor || !range) return;
	const name = characterDisplayName(character);
	const prefix = editor.value.slice(0, range.start);
	const suffix = editor.value.slice(range.end);
	const insert = `@${name}`;
	const spacer = suffix && !/^[\s\n，。；：、,.!?;:]/.test(suffix) ? " " : "";
	editor.value = `${prefix}${insert}${spacer}${suffix}`;
	const nextCaret = prefix.length + insert.length + spacer.length;
	editor.focus();
	editor.setSelectionRange(nextCaret, nextCaret);
	setWidgetValue(node, PROMPT_WIDGET, editor.value);
	saveActorIfNeeded(node, character);
	closeActorMentionMenu(node);
}

function positionActorMentionMenu(node) {
	const state = node?.__gjjGemmaPanel;
	const editor = state?.promptEditor;
	const menu = state?.actorMentionMenu;
	if (!editor || !menu) return;
	const rect = editor.getBoundingClientRect();
	const width = Math.min(300, Math.max(210, rect.width * 0.58));
	menu.style.width = `${width}px`;
	menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + 8))}px`;
	menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 280, rect.bottom - 4))}px`;
}

function renderActorMentionMenu(node) {
	const state = node?.__gjjGemmaPanel;
	const menu = state?.actorMentionMenu;
	if (!state || !menu) return;
	const options = state.actorMentionOptions || [];
	const active = Math.max(0, Math.min(Number(state.actorMentionActive || 0), Math.max(0, options.length - 1)));
	state.actorMentionActive = active;
	menu.replaceChildren();
	const title = document.createElement("div");
	title.className = "gjj-gemma-mention-title";
	title.textContent = "@角色库人物";
	menu.appendChild(title);
	if (!options.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-gemma-mention-empty";
		empty.textContent = "没有匹配的人物";
		menu.appendChild(empty);
		positionActorMentionMenu(node);
		return;
	}
	options.forEach((character, index) => {
		const item = document.createElement("button");
		item.type = "button";
		item.className = `gjj-gemma-mention-item${index === active ? " active" : ""}`;
		const image = prioritizeIconImage(document.createElement("img"));
		setGjjLibraryThumbnail(image, api, "character", character);
		const main = document.createElement("div");
		main.className = "gjj-gemma-mention-main";
		main.textContent = characterDisplayName(character);
		const detail = document.createElement("div");
		detail.className = "gjj-gemma-mention-detail";
		detail.textContent = String(character?.notes || character?.id || "").replace(/\s+/g, " ").trim();
		const text = document.createElement("span");
		text.append(main, detail);
		item.append(image, text);
		item.addEventListener("pointermove", () => {
			state.actorMentionActive = index;
			renderActorMentionMenu(node);
		});
		item.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			chooseActorMention(node, character);
		});
		menu.appendChild(item);
	});
	positionActorMentionMenu(node);
}

async function syncActorMentionMenu(node) {
	const state = node?.__gjjGemmaPanel;
	const editor = state?.promptEditor;
	const range = actorMentionRange(editor);
	if (!state || !editor || !range) {
		closeActorMentionMenu(node);
		return;
	}
	let data;
	try {
		data = await loadCharacterSummaries();
	} catch (error) {
		console.warn("[GJJ GemmaTextGenerate] 读取角色库 @ 候选失败：", error);
		return;
	}
	const query = range.query.toLocaleLowerCase();
	const characters = Array.isArray(data.characters) ? data.characters : [];
	const options = characters
		.filter((character) => {
			const searchable = [characterDisplayName(character), character?.name, character?.id, character?.notes].filter(Boolean).join(" ").toLocaleLowerCase();
			return !query || searchable.includes(query);
		})
		.sort((left, right) => Number(right?.updated_at || 0) - Number(left?.updated_at || 0))
		.slice(0, 12);
	state.actorMentionOptions = options;
	state.actorMentionActive = Math.min(Number(state.actorMentionActive || 0), Math.max(0, options.length - 1));
	if (!state.actorMentionMenu) {
		const menu = document.createElement("div");
		menu.className = "gjj-gemma-mention-menu";
		protect(menu);
		document.body.appendChild(menu);
		state.actorMentionMenu = menu;
	}
	renderActorMentionMenu(node);
}

function bindActorMentionEditor(node, editor) {
	editor.addEventListener("input", () => {
		window.setTimeout(() => syncActorMentionMenu(node), 0);
	});
	editor.addEventListener("click", () => syncActorMentionMenu(node));
	editor.addEventListener("keyup", (event) => {
		if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
		syncActorMentionMenu(node);
	});
	editor.addEventListener("keydown", (event) => {
		const state = node?.__gjjGemmaPanel;
		const menu = state?.actorMentionMenu;
		if (!menu) {
			if (event.key === "@") window.setTimeout(() => syncActorMentionMenu(node), 0);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeActorMentionMenu(node);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const count = Math.max(1, state.actorMentionOptions?.length || 1);
			state.actorMentionActive = (Number(state.actorMentionActive || 0) + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
			renderActorMentionMenu(node);
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			const character = state.actorMentionOptions?.[Number(state.actorMentionActive || 0)];
			if (!character) return;
			event.preventDefault();
			chooseActorMention(node, character);
		}
	});
}

function renderActorChips(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state?.actorChips) return;
	const actors = selectedActors(node);
	state.actorChips.replaceChildren();
	state.actorChips.style.display = actors.length ? "flex" : "none";
	for (const [index, actor] of actors.entries()) {
		const actorId = String(actor.id);
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "gjj-gemma-actor-chip";
		chip.setAttribute("aria-label", `${actorPromptLine(actor)}；点击添加引用，Ctrl/Cmd+点击移除`);
		chip.title = `${actorPromptLine(actor)}；点击添加引用，Ctrl/Cmd+点击移除`;
		const actorCoverUrl = characterCover(actor);
		if (actorCoverUrl) {
			const image = prioritizeIconImage(document.createElement("img"));
			image.dataset.gjjActorAvatarId = actorId;
			setGjjLibraryThumbnail(image, api, "character", actor);
			chip.appendChild(image);
		}
		const name = document.createElement("span");
		name.textContent = `@${characterDisplayName(actor)}`;
		chip.appendChild(name);
		chip.addEventListener("mouseenter", () => {
			if (!actorCoverUrl) return;
			const notes = String(actor.notes || "").replace(/\s+/g, " ").trim();
			showFloatingPreview(chip, actorCoverUrl, `${actorPromptLine(actor)}${notes ? `（${notes}）` : ""}`);
		});
		chip.addEventListener("mouseleave", () => closeFloatingPreview(chip));
		chip.addEventListener("click", (event) => {
			if (chip.__gjjJustDragged) return;
			closeFloatingPreview(chip);
			event.preventDefault();
			event.stopPropagation();
			if (event.ctrlKey || event.metaKey) {
				saveActors(node, actors.filter((item) => String(item.id) !== String(actor.id)));
				return;
			}
			appendReferenceToPrompt(node, actorPromptLine(actor));
		});
		makeReferenceChipSortable(chip, actors, index, "actor", (items) => saveActors(node, items));
		state.actorChips.appendChild(chip);
	}
}

function installActorPromptTrigger(node) {
	// 角色信息改为隐性注入到用户指令前面，不再需要在 prompt 中输入 @名 触发角色选择器。
	// 此函数保留为空函数，避免调用处报错；onRemoved 中仍会清理 __gjjGemmaActorTriggerHandler（始终为 null）。
	if (!node) return;
}

function logicalKeywordMatch(value, query) {
	const source = String(query || "").trim();
	if (!source) return true;
	const haystack = String(value || "").toLocaleLowerCase();
	const tokens = [];
	const pattern = /\s*(\(|\)|&&|\|\||\||!|\bAND\b|\bOR\b|\bNOT\b|"[^"]*"|'[^']*'|[^\s()!|&]+)/giy;
	let match;
	while ((match = pattern.exec(source))) {
		let token = match[1];
		if (/^and$/i.test(token) || token === "&&") token = "AND";
		else if (/^or$/i.test(token) || token === "||" || token === "|") token = "OR";
		else if (/^not$/i.test(token) || token === "!") token = "NOT";
		else if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
		if (token.startsWith("-") && token.length > 1) tokens.push("NOT", token.slice(1));
		else tokens.push(token);
	}
	const expression = [];
	for (const token of tokens) {
		const previous = expression.at(-1);
		if (expression.length && token !== "(" && token !== ")" && token !== "AND" && token !== "OR"
			&& previous !== "(" && previous !== "AND" && previous !== "OR" && previous !== "NOT") expression.push("AND");
		if (token === "(" && previous && previous !== "(" && previous !== "AND" && previous !== "OR" && previous !== "NOT") expression.push("AND");
		expression.push(token);
	}
	let index = 0;
	const primary = () => {
		if (expression[index] === "(") {
			index += 1;
			const value = parseOr();
			if (expression[index] === ")") index += 1;
			return value;
		}
		const keyword = String(expression[index++] || "").toLocaleLowerCase();
		return keyword ? haystack.includes(keyword) : true;
	};
	const unary = () => expression[index] === "NOT" ? (index += 1, !unary()) : primary();
	const parseAnd = () => {
		let value = unary();
		while (expression[index] === "AND") { index += 1; value = unary() && value; }
		return value;
	};
	function parseOr() {
		let value = parseAnd();
		while (expression[index] === "OR") { index += 1; value = parseAnd() || value; }
		return value;
	}
	return parseOr();
}

async function toggleActorPicker(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state) return;
	state.scenePicker?.remove();
	state.scenePicker = null;
	state.sceneButton?.classList.remove("active");
	if (state.actorPicker?.isConnected) {
		state.actorPicker.remove();
		state.actorPicker = null;
		state.actorButton.classList.remove("active");
		return;
	}
	if (!characterSummariesPromise) {
		characterSummariesPromise = api.fetchApi(`${CHARACTER_LIBRARY_ENDPOINT}?summary=1`)
			.then(async (response) => {
				const data = await response.json();
				if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取角色库失败");
				return data;
			})
			.catch((error) => {
				characterSummariesPromise = null;
				throw error;
			});
	}
	const data = await characterSummariesPromise;
	const characters = Array.isArray(data.characters) ? data.characters : [];
	renderActorChips(node);
	const picker = document.createElement("div");
	picker.className = "gjj-gemma-actor-picker";
	const tools = document.createElement("div");
	tools.className = "gjj-gemma-actor-tools";
	const grid = document.createElement("div");
	grid.className = "gjj-gemma-actor-grid";
	let gender = "all";
	let sort = "updated_desc";
	let lastClickedIndex = -1;
	let keywordQuery = "";
	const genderButtons = [];

	const render = () => {
		const selectedIds = new Set(selectedActors(node).map((item) => String(item.id)));
		const filtered = characters.filter((character) => {
			const rawName = String(character?.name || "");
			const genderMatches = gender === "all" || (gender === "female" ? rawName.includes("♀") : rawName.includes("♂"));
			if (!genderMatches) return false;
			const searchable = [characterDisplayName(character), rawName, character?.id, character?.notes].filter(Boolean).join(" ");
			return logicalKeywordMatch(searchable, keywordQuery);
		});
		filtered.sort((left, right) => {
			if (sort === "name_asc") return characterDisplayName(left).localeCompare(characterDisplayName(right), "zh-Hans");
			return Number(right?.updated_at || 0) - Number(left?.updated_at || 0);
		});
		grid.replaceChildren();
		filtered.forEach((character, index) => {
			const item = document.createElement("button");
			item.type = "button";
			item.className = `gjj-gemma-actor-item${selectedIds.has(String(character.id)) ? " active" : ""}`;
			item.dataset.index = String(index);
			const image = prioritizeIconImage(document.createElement("img"));
			const cover = characterCover(character);
			if (cover) setGjjLibraryThumbnail(image, api, "character", character);
			const name = document.createElement("span");
			name.textContent = characterDisplayName(character);
			item.append(image, name);
			item.addEventListener("mouseenter", () => {
				if (!cover) return;
				const notes = String(character?.notes || "").replace(/\s+/g, " ").trim();
				showFloatingPreview(item, cover, `${actorPromptLine(character)}${notes ? `（${notes}）` : ""}`);
			});
			item.addEventListener("mouseleave", () => closeFloatingPreview(item));
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				closeFloatingPreview(item);
				if (event.shiftKey && lastClickedIndex >= 0) {
					// Shift+点击：从上次点击位置到当前做范围选择；按 Ctrl 时为追加模式
					applyActorRangeSelection(node, filtered, lastClickedIndex, index, event.ctrlKey || event.metaKey);
				} else if (event.ctrlKey || event.metaKey) {
					// Ctrl/Cmd+点击：在当前选中基础上切换该角色
					toggleActorSelection(node, character);
				} else {
					// 普通点击：切换该角色（保留多选语义，不关闭面板）
					toggleActorSelection(node, character);
					lastClickedIndex = index;
				}
				if (!event.shiftKey) lastClickedIndex = index;
				render();
			});
			grid.appendChild(item);
		});
		if (!filtered.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-gemma-actor-empty";
			empty.textContent = characters.length ? "没有符合过滤条件的人物" : "角色库中还没有人物";
			grid.appendChild(empty);
		}
	};
	for (const [value, label] of [["all", "全部"], ["female", "♀"], ["male", "♂"]]) {
		const control = button(label, `过滤：${label}`, () => {
			gender = value;
			for (const entry of genderButtons) entry.classList.toggle("active", entry.dataset.gender === gender);
			render();
		});
		control.classList.add("compact");
		control.dataset.gender = value;
		control.classList.toggle("active", value === gender);
		genderButtons.push(control);
		tools.appendChild(control);
	}
	const sortButton = button("🕘 最新", "切换按最新或名称排序", () => {
		sort = sort === "updated_desc" ? "name_asc" : "updated_desc";
		sortButton.textContent = sort === "updated_desc" ? "🕘 最新" : "🔤 名称";
		render();
	});
	sortButton.classList.add("compact");
	tools.appendChild(sortButton);
	const clearButton = button("清空", "清空当前已选角色", () => {
		saveActors(node, []);
		render();
	});
	clearButton.classList.add("compact");
	tools.appendChild(clearButton);
	const keywordFilter = document.createElement("input");
	keywordFilter.type = "text";
	keywordFilter.className = "gjj-gemma-actor-keyword-filter";
	keywordFilter.placeholder = "关键词：王冬儿 OR 蒂法 NOT 黑衣";
	keywordFilter.title = "支持空格/AND、OR/|、NOT/!/-、括号和引号短语；搜索角色名、ID 与备注";
	keywordFilter.addEventListener("input", () => {
		keywordQuery = keywordFilter.value;
		lastClickedIndex = -1;
		render();
	});
	keywordFilter.addEventListener("keydown", (event) => event.stopPropagation());
	tools.appendChild(keywordFilter);
	const confirmButton = button("确定", "保存选择并关闭角色库", () => {
		closeActorPicker(node);
	});
	confirmButton.classList.add("compact");
	tools.appendChild(confirmButton);
	picker.append(tools, grid);
	render();
	state.root.appendChild(picker);
	state.actorPicker = picker;
	state.actorButton.classList.add("active");
}

function closeActorPicker(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state) return;
	closeFloatingPreview();
	state.actorPicker?.remove();
	state.actorPicker = null;
	state.actorButton?.classList.remove("active");
	GJJ_Utils.dirtyCanvas(node);
}

async function toggleScenePicker(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state) return;
	if (state.scenePicker?.isConnected) {
		state.scenePicker.remove();
		state.scenePicker = null;
		state.sceneButton.classList.remove("active");
		return;
	}
	state.actorPicker?.remove();
	state.actorPicker = null;
	state.actorButton.classList.remove("active");
	const response = await api.fetchApi(SCENE_LIBRARY_ENDPOINT);
	const data = await response.json();
	if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取场景库失败");
	const scenes = Array.isArray(data.scenes) ? data.scenes : [];
	const picker = document.createElement("div");
	picker.className = "gjj-gemma-actor-picker";
	const tools = document.createElement("div");
	tools.className = "gjj-gemma-actor-tools";
	const grid = document.createElement("div");
	grid.className = "gjj-gemma-actor-grid";
	let query = "";
	const render = () => {
		const selectedIds = new Set(selectedScenes(node).map((item) => String(item.id)));
		const filtered = scenes.filter((scene) => logicalKeywordMatch([
			sceneDisplayName(scene), scene?.id, scene?.notes, ...(scene?.keywords || []),
		].filter(Boolean).join(" "), query));
		grid.replaceChildren();
		for (const scene of filtered) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = `gjj-gemma-actor-item${selectedIds.has(String(scene.id)) ? " active" : ""}`;
			const image = prioritizeIconImage(document.createElement("img"));
			const cover = sceneCover(scene);
			if (cover) setGjjLibraryThumbnail(image, api, "scene", scene);
			const name = document.createElement("span");
			name.textContent = sceneDisplayName(scene);
			item.append(image, name);
			item.title = String(scene.notes || sceneDisplayName(scene));
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const current = selectedScenes(node);
				const exists = current.some((entry) => String(entry.id) === String(scene.id));
				saveScenes(node, exists ? current.filter((entry) => String(entry.id) !== String(scene.id)) : [...current, { ...scene, cover }]);
				render();
			});
			grid.appendChild(item);
		}
	};
	const search = document.createElement("input");
	search.type = "text";
	search.className = "gjj-gemma-actor-keyword-filter";
	search.placeholder = "搜索场景名称、关键词或备注";
	search.addEventListener("input", () => { query = search.value; render(); });
	search.addEventListener("keydown", (event) => event.stopPropagation());
	const clear = button("清空", "清空已选场景", () => { saveScenes(node, []); render(); });
	clear.classList.add("compact");
	const confirm = button("确定", "保存选择并关闭场景库", () => closeFloatingPanels(node));
	confirm.classList.add("compact");
	tools.append(search, clear, confirm);
	picker.append(tools, grid);
	render();
	state.root.appendChild(picker);
	state.scenePicker = picker;
	state.sceneButton.classList.add("active");
}

function collectWorkflowValues(node) {
	const values = {};
	for (const name of STATE_WIDGETS) {
		const target = widget(node, name);
		if (target) values[name] = target.value ?? "";
	}
	values.selected_actors = selectedActors(node)
		.map((actor) => characterDisplayName(actor))
		.filter(Boolean);
	values.selected_scenes = selectedScenes(node)
		.map((scene) => sceneDisplayName(scene))
		.filter(Boolean);
	return values;
}

function rememberWorkflowValues(node, serializedNode = null) {
	if (!node || node.__gjjGemmaRestoring) return;
	const values = collectWorkflowValues(node);
	const storage = widget(node, WORKFLOW_VALUES_WIDGET);
	const storageText = JSON.stringify(values);
	if (storage) storage.value = storageText;
	node.properties ||= {};
	node.properties[WORKFLOW_VALUES_PROPERTY] = { ...values };
	const ordered = BACKEND_WIDGETS.map((name) =>
		name === WORKFLOW_VALUES_WIDGET ? storageText : (values[name] ?? ""));
	node.widgets_values = ordered.slice();
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties[WORKFLOW_VALUES_PROPERTY] = { ...values };
		serializedNode.widgets_values = ordered.slice();
	}
}

function candidateFromOrder(rawValues, order, offset = 0) {
	if (!Array.isArray(rawValues) || rawValues.length <= offset) return null;
	const values = {};
	for (let index = 0; index < Math.min(order.length, rawValues.length - offset); index += 1) {
		values[order[index]] = rawValues[index + offset];
	}
	return values;
}

function workflowScore(values) {
	if (!values) return -100;
	let score = 0;
	const clipName = String(values.clip_name ?? "");
	if (/gemma|ideogram|\.safetensors$|\.gguf$/i.test(clipName)) score += 8;
	if (["ideogram4", "stable_diffusion", "sd3", "wan", "qwen_image", "flux2"].includes(String(values.clip_type ?? ""))) score += 5;
	if (["default", "cpu"].includes(String(values.clip_device ?? ""))) score += 4;
	if (["GPU优先", "CPU优先"].includes(String(values.device_preference ?? ""))) score += 4;
	if (["on", "off"].includes(String(values.sampling_mode ?? ""))) score += 3;
	if (typeof values.thinking === "boolean") score += 2;
	if (typeof values.use_default_template === "boolean") score += 2;
	if (typeof values.keep_model === "boolean") score += 2;
	for (const [name, min, max] of [
		["max_length", 1, 32768],
		["temperature", 0.01, 2],
		["top_k", 0, 1000],
		["top_p", 0, 1],
		["min_p", 0, 1],
		["repetition_penalty", 0, 5],
		["presence_penalty", 0, 5],
	]) {
		const number = Number(values[name]);
		if (Number.isFinite(number) && number >= min && number <= max) score += 1;
	}
	const templates = String(values[TEMPLATE_WIDGET] ?? "");
	if (parseTemplateText(templates).length > 1 || /【[^】]+】/.test(templates)) score += 8;
	return score;
}

function restoreWorkflowValues(node, serializedNode) {
	const saved = serializedNode?.properties?.[WORKFLOW_VALUES_PROPERTY]
		|| node?.properties?.[WORKFLOW_VALUES_PROPERTY];
	let values = saved && typeof saved === "object" ? { ...saved } : null;
	const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	const jsonIndex = BACKEND_WIDGETS.indexOf(WORKFLOW_VALUES_WIDGET);
	const jsonCandidates = [
		widget(node, WORKFLOW_VALUES_WIDGET)?.value,
		jsonIndex >= 0 ? raw[jsonIndex] : null,
		jsonIndex >= 0 ? raw[jsonIndex + 1] : null,
	];
	for (const candidate of jsonCandidates) {
		if (typeof candidate !== "string" || !candidate.trim()) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				values = { ...(values || {}), ...parsed };
				break;
			}
		} catch (_) {}
	}
	if (!values) {
		const candidates = [];
		for (const order of [BACKEND_WIDGETS, REORDERED_WIDGETS]) {
			for (const offset of [0, 1]) {
				const candidate = candidateFromOrder(raw, order, offset);
				if (candidate) candidates.push({ values: candidate, score: workflowScore(candidate) });
			}
		}
		candidates.sort((left, right) => right.score - left.score);
		values = candidates[0]?.values || null;
	}
	if (!values) return;
	if (values.keep_model === undefined) values.keep_model = true;
	if (values.device_preference === undefined) values.device_preference = String(values.clip_device || "") === "cpu" ? "CPU优先" : "GPU优先";
	node.__gjjGemmaRestoring = true;
	try {
		for (const name of BACKEND_WIDGETS) {
			const target = widget(node, name);
			if (!target || values[name] === undefined) continue;
			let value = values[name];
			if (NUMERIC_WIDGETS.has(name)) {
				const parsed = Number(value);
				value = Number.isFinite(parsed) ? parsed : NUMERIC_DEFAULTS[name];
			} else if (typeof target.value === "number") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) value = parsed;
			} else if (typeof target.value === "boolean") {
				value = value === true || String(value).toLowerCase() === "true";
			} else {
				value = String(value ?? "");
			}
			target.value = value;
			if (target.inputEl && "value" in target.inputEl) target.inputEl.value = value;
			if (target.element && "value" in target.element) target.element.value = value;
		}
	} finally {
		node.__gjjGemmaRestoring = false;
	}
	repairMissingClipName(node);
	rememberWorkflowValues(node);
}

function asBool(value) {
	return value === true || ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());
}

function keepModelEnabled(node) {
	return asBool(widgetValue(node, "keep_model", false));
}

function devicePreferenceValue(node) {
	return String(widgetValue(node, "device_preference", "GPU优先") || "GPU优先").includes("CPU") ? "CPU优先" : "GPU优先";
}

function setKeepModel(node, enabled) {
	setWidgetValue(node, "keep_model", !!enabled);
}

function setDevicePreference(node, value) {
	const next = String(value || "").includes("CPU") ? "CPU优先" : "GPU优先";
	setWidgetValue(node, "device_preference", next);
	setWidgetValue(node, "clip_device", next === "CPU优先" ? "cpu" : "default");
}

function splitTemplateBlocks(rawText) {
	const blocks = [];
	let current = [];
	for (const line of String(rawText || "").replace(/\r\n/g, "\n").split("\n")) {
		if (/^\s*-{3,}\s*$/.test(line) || (!line.trim() && current.some((item) => item.trim()))) {
			blocks.push(current.join("\n").trim());
			current = [];
			continue;
		}
		if (line.trim() || current.length) current.push(line);
	}
	if (current.some((item) => item.trim())) blocks.push(current.join("\n").trim());
	return blocks.filter(Boolean);
}

function migrateLegacyTemplateText(rawText) {
	return String(rawText || "").replaceAll(LEGACY_LYRICS_TEMPLATE, ORIGINAL_LYRICS_TEMPLATE);
}

function parseTemplateText(rawText) {
	return splitTemplateBlocks(migrateLegacyTemplateText(rawText)).map((block, index) => {
		const match = block.match(/^【([^】]+)】\s*([\s\S]*)$/);
		if (!match) return null;
		return {
			key: `${index}:${String(match[1]).trim()}`,
			title: String(match[1]).trim(),
			text: String(match[2]).trim(),
		};
	}).filter((item) => item?.title && item?.text);
}

function templateTextToItems(text) {
	return parseTemplateText(text).map((item) => ({ title: item.title, prompt: item.text }));
}

function normalizeSharedSettings(settings) {
	const section = settings?.[USER_SETTINGS_SECTION] || settings || {};
	let templateText = String(section.system_prompt_templates || "").trim();
	if (!templateText && Array.isArray(section.templates)) {
		templateText = section.templates.map((item) => {
			const title = String(item?.title || item?.label || "").trim();
			const prompt = String(item?.prompt || item?.text || "").trim();
			return title && prompt ? `【${title}】${prompt}` : "";
		}).filter(Boolean).join("\n\n");
	}
	return {
		templateText,
		outputRule: String(section.system_prompt_output_rule || "").trim(),
	};
}

function loadSharedSettings() {
	if (!sharedSettingsPromise) {
		sharedSettingsPromise = api.fetchApi(USER_SETTINGS_ENDPOINT)
			.then((response) => response.json())
			.then((data) => normalizeSharedSettings(data?.settings || {}))
			.catch(() => ({ templateText: "", outputRule: "" }));
	}
	return sharedSettingsPromise;
}

async function saveSharedTemplates(node) {
	const templateText = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "");
	const response = await api.fetchApi(USER_SETTINGS_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			section: USER_SETTINGS_SECTION,
			values: {
				system_prompt_templates: templateText,
				templates: templateTextToItems(templateText),
				system_prompt_output_rule: outputRule,
			},
		}),
	});
	const data = await response.json();
	if (!response.ok || !data?.ok) throw new Error(data?.error || "保存失败");
	sharedSettingsPromise = Promise.resolve(normalizeSharedSettings(data.settings || {}));
	return data;
}

function templatePrompt(config, item) {
	return [String(item?.text || "").trim(), String(config?.outputRule || "").trim()]
		.filter(Boolean)
		.join("\n");
}

function button(label, title, handler) {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "gjj-ia-button";
	element.textContent = label;
	element.title = title;
	protect(element);
	element.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		handler();
	});
	return element;
}

function textField(type, title) {
	const element = document.createElement("input");
	element.type = type;
	element.title = title;
	element.className = "gjj-ia-input";
	element.autocomplete = "off";
	protect(element);
	return element;
}

function selectField(title, options = []) {
	const element = document.createElement("select");
	element.title = title;
	element.className = "gjj-ia-input";
	for (const option of options) {
		const item = document.createElement("option");
		item.value = option;
		item.textContent = option;
		element.appendChild(item);
	}
	protect(element);
	return element;
}

function matchesKeywordFilter(value, query) {
	const text = String(value || "").toLowerCase();
	const groups = String(query || "")
		.toLowerCase()
		.split(/[|｜]/)
		.map((group) => group.trim())
		.filter(Boolean);
	if (!groups.length) return true;
	return groups.some((group) => {
		const terms = group.split(/\s+/).filter(Boolean);
		return terms.length > 0 && terms.every((term) => text.includes(term));
	});
}

function searchableSelectField(title, placeholder = "关键词过滤：空格=同时包含，|=任一包含") {
	const root = document.createElement("div");
	root.className = "gjj-ia-search-select";
	root.title = title;
	protect(root);

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "gjj-ia-input gjj-ia-search-trigger";
	trigger.title = title;
	protect(trigger);

	const popup = document.createElement("div");
	popup.className = "gjj-ia-search-popup";
	popup.style.display = "none";
	protect(popup);

	const filter = textField("text", placeholder);
	filter.classList.add("gjj-ia-search-filter");
	filter.placeholder = placeholder;

	const hint = document.createElement("div");
	hint.className = "gjj-ia-search-hint";
	hint.textContent = "空格：同时包含　|：任一包含";

	const list = document.createElement("div");
	list.className = "gjj-ia-search-list";
	popup.append(filter, hint, list);
	document.body.appendChild(popup);

	const state = {
		options: [],
		value: "",
		filterValue: "",
		onChange: null,
		onFilterChange: null,
	};
	root.__gjjSearchSelect = state;

	const close = () => {
		popup.style.display = "none";
		root.classList.remove("open");
	};
	const positionPopup = () => {
		const anchor = state.anchor || trigger;
		const rect = anchor.getBoundingClientRect();
		const width = Math.max(320, rect.width);
		const maxLeft = Math.max(8, window.innerWidth - width - 8);
		popup.style.width = `${width}px`;
		popup.style.left = `${Math.max(8, Math.min(maxLeft, rect.left))}px`;
		popup.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 4)}px`;
	};
	const render = () => {
		const filtered = state.options.filter((value) => matchesKeywordFilter(value, filter.value));
		list.replaceChildren();
		if (!filtered.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-ia-search-empty";
			empty.textContent = "没有匹配项";
			list.appendChild(empty);
			return;
		}
		for (const value of filtered) {
			const option = document.createElement("button");
			option.type = "button";
			option.className = "gjj-ia-search-option";
			option.textContent = value;
			option.title = value;
			option.classList.toggle("active", value === state.value);
			protect(option);
			option.addEventListener("click", () => {
				state.value = value;
				trigger.textContent = value;
				trigger.title = value;
				state.onChange?.(value);
				close();
			});
			list.appendChild(option);
		}
	};
	const open = (anchor = trigger) => {
		state.anchor = anchor;
		positionPopup();
		popup.style.display = "flex";
		root.classList.add("open");
		filter.value = state.filterValue;
		render();
		requestAnimationFrame(() => filter.focus());
	};

	trigger.addEventListener("click", () => {
		if (popup.style.display === "none") open(trigger);
		else close();
	});
	filter.addEventListener("input", () => {
		state.filterValue = filter.value;
		state.onFilterChange?.(filter.value);
		render();
	});
	filter.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (!root.contains(event.target) && !popup.contains(event.target)) close();
	});
	window.addEventListener("resize", () => {
		if (popup.style.display !== "none") positionPopup();
	});
	window.addEventListener("scroll", (event) => {
		if (popup.contains(event.target)) return;
		close();
	}, true);
	root.__gjjSearchSelectClose = close;
	root.__gjjSearchSelectOpen = open;
	root.__gjjSearchSelectRender = render;
	root.__gjjSearchSelectPopup = popup;
	root.appendChild(trigger);
	return root;
}

function syncSearchableSelect(control, values, selected, filterValue = "") {
	const state = control?.__gjjSearchSelect;
	if (!state) return;
	const normalized = Array.from(new Set((values || []).map(String)));
	const signature = JSON.stringify(normalized);
	if (state.optionsSignature !== signature) {
		state.optionsSignature = signature;
		state.options = normalized;
	}
	state.value = String(selected ?? "");
	const filter = control.__gjjSearchSelectPopup?.querySelector(".gjj-ia-search-filter");
	if (document.activeElement !== filter) {
		state.filterValue = String(filterValue ?? "");
		if (filter) filter.value = state.filterValue;
	}
	const trigger = control.querySelector(".gjj-ia-search-trigger");
	if (trigger) {
		trigger.textContent = state.value || "未选择";
		trigger.title = state.value || control.title || "选择模型";
	}
	control.__gjjSearchSelectRender?.();
}

function labelledField(label, control, action = null) {
	const line = document.createElement("label");
	line.className = "gjj-ia-field";
	line.title = control?.title || "";
	const name = document.createElement("span");
	name.textContent = label;
	name.className = "gjj-ia-label";
	if (action) {
		const header = document.createElement("span");
		header.className = "gjj-ia-label-row";
		header.append(name, action);
		line.append(header, control);
	} else {
		line.append(name, control);
	}
	return line;
}

function parameterField(label, control) {
	const line = labelledField(label, control);
	line.classList.add("gjj-ia-param");
	return line;
}

function choices(name, node) {
	const target = widget(node, name);
	let values = target?.options?.values || target?.options?.items || target?.values;
	if (typeof values === "function") {
		try { values = values(); } catch (_) { values = []; }
	}
	return Array.isArray(values) ? values.map(String) : [];
}

function repairMissingClipName(node) {
	const target = widget(node, "clip_name");
	if (!target) return false;
	const values = choices("clip_name", node);
	if (!values.length) return false;

	const current = String(target.value || "");
	if (values.includes(current)) return false;
	const basename = (value) => String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
	const requestedName = basename(current);
	const replacement = values.find((candidate) => basename(candidate) === requestedName);
	if (!replacement) return false;

	target.value = replacement;
	if (target.inputEl && "value" in target.inputEl) target.inputEl.value = replacement;
	if (target.element && "value" in target.element) target.element.value = replacement;
	node.properties ||= {};
	node.properties[WORKFLOW_VALUES_PROPERTY] ||= {};
	node.properties[WORKFLOW_VALUES_PROPERTY].clip_name = replacement;
	return true;
}

function syncSelectOptions(control, values, selected) {
	const signature = JSON.stringify(values);
	if (control.__gjjOptionsSignature !== signature) {
		control.__gjjOptionsSignature = signature;
		control.replaceChildren();
		for (const value of values) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value;
			control.appendChild(option);
		}
	}
	if (document.activeElement !== control) control.value = String(selected ?? "");
}

function syncInputValue(control, value) {
	if (document.activeElement !== control && control.value !== String(value ?? "")) {
		control.value = String(value ?? "");
	}
}

function bindWidgetControl(node, name, control, converter = (value) => value) {
	control.addEventListener("change", () => {
		setWidgetValue(node, name, converter(control.value));
		syncPanel(node);
	});
}

function numericControl(node, name, title, min, max, step, integer = false) {
	const control = textField("number", title);
	control.min = String(min);
	control.max = String(max);
	control.step = String(step);
	bindWidgetControl(node, name, control, (value) => {
		const parsed = integer ? Number.parseInt(value || "0", 10) : Number.parseFloat(value || "0");
		return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : 0));
	});
	return control;
}

function hideBackendWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		const target = widget(node, name);
		GJJ_Utils.hideWidget(target);
		if (target) {
			target.options ||= {};
			target.options.hidden = true;
			target.options.display = "hidden";
		}
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	if (Array.isArray(node?.inputs)) {
		for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
			const input = node.inputs[index];
			const candidates = [
				input?.name,
				input?.label,
				input?.localized_name,
				input?.widget?.name,
				String(input?.type || "").replace(/^converted-widget:/, ""),
			].map((value) => String(value || ""));
			if (!candidates.some((name) => HIDDEN_WIDGETS.has(name))) continue;
			try { node.disconnectInput?.(index); } catch (_) {}
			if (typeof node.removeInput === "function") node.removeInput(index);
			else node.inputs.splice(index, 1);
		}
	}
	const storage = widget(node, WORKFLOW_VALUES_WIDGET);
	if (storage) {
		storage.hidden = true;
		storage.type = `converted-widget:${WORKFLOW_VALUES_WIDGET}`;
		storage.computeSize = () => [0, 0];
		storage.getHeight = () => 0;
		storage.draw = () => {};
		storage.last_y = 0;
		storage.computedHeight = 0;
		storage.margin_top = 0;
		storage.size = [0, 0];
	}
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function restorePromptWidget(node) {
	const target = widget(node, PROMPT_WIDGET);
	if (!target) return null;
	target.hidden = false;
	target.disabled = false;
	if (String(target.type || "").startsWith("converted-widget:")) target.type = "customtext";
	if (target.__gjjUtilsHidden) delete target.__gjjUtilsHidden;
	target.label = "指令 / 原文";
	target.options ||= {};
	delete target.options.hidden;
	delete target.options.display;
	target.options.multiline = true;
	target.computeSize = (width) => [
		Math.max(260, Number(width || node.size?.[0] || 470)),
		PROMPT_HEIGHT,
	];
	target.getHeight = () => PROMPT_HEIGHT;
	target.draw = undefined;
	target.last_y = 0;
	target.computedHeight = PROMPT_HEIGHT;
	target.margin_top = 0;
	target.size = [Math.max(260, Number(node.size?.[0] || 470)), PROMPT_HEIGHT];
	if (target.element?.style) target.element.style.display = "";
	if (target.inputEl?.style) target.inputEl.style.display = "";
	return target;
}

function hideNativePromptWidget(node) {
	const target = widget(node, PROMPT_WIDGET);
	if (!target) return;
	GJJ_Utils.hideWidget(target);
	target.serialize = true;
}

function ensurePromptInput(node) {
	if (!Array.isArray(node?.inputs)) node.inputs = [];
	let promptInput = node.inputs.find((input) =>
		String(input?.name || "") === EXTERNAL_PROMPT_INPUT);
	if (!promptInput) {
		node.addInput?.(EXTERNAL_PROMPT_INPUT, "STRING");
		promptInput = node.inputs[node.inputs.length - 1];
	}
	if (!promptInput) return;
	promptInput.name = EXTERNAL_PROMPT_INPUT;
	promptInput.type = "STRING";
	promptInput.label = "指令 / 原文";
	promptInput.localized_name = "指令 / 原文";
	promptInput.display_name = "指令 / 原文";
	promptInput.tooltip = "外接 STRING 时作为用户指令；未连接时使用节点内文本框。";
	promptInput.hidden = false;
	promptInput.visible = true;
	delete promptInput.widget;
	delete promptInput.widget_name;
	promptInput.forceInput = true;
}

function normalizeMediaInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	let mediaInput = node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT);
	if (!mediaInput) {
		mediaInput = node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")) && input?.link != null)
			|| node.inputs.find((input) => String(input?.name || "") === AUDIO_INPUT && input?.link != null)
			|| node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")));
	}
	if (!mediaInput) {
		node.addInput?.(MEDIA_INPUT, MEDIA_INPUT_TYPE);
		mediaInput = node.inputs[node.inputs.length - 1];
	}
	if (!mediaInput) return;
	mediaInput.name = MEDIA_INPUT;
	mediaInput.type = MEDIA_INPUT_TYPE;
	mediaInput.label = "媒体";
	mediaInput.localized_name = "媒体";
	mediaInput.tooltip = "统一支持 IMAGE、GJJ_BATCH_IMAGE、VIDEO、AUDIO；节点会按输入类型自动分流。";
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (input !== mediaInput && String(input?.name || "") === AUDIO_INPUT) {
			node.removeInput?.(index);
		}
	}
}

function graphLink(node, linkId) {
	if (linkId && typeof linkId === "object") return linkId;
	const links = node?.graph?.links ?? app?.graph?.links;
	if (links instanceof Map) return links.get(linkId) ?? links.get(String(linkId)) ?? null;
	if (Array.isArray(links)) return links[Number(linkId)] ?? null;
	return links?.[linkId] ?? links?.[String(linkId)] ?? null;
}

function syncMediaInputRoute(node) {
	const input = node?.inputs?.find((item) => String(item?.name || "") === MEDIA_INPUT);
	if (!input) return;
	if (input.link == null) {
		input.type = MEDIA_INPUT_TYPE;
		input.label = "媒体";
		input.localized_name = "媒体";
		return;
	}
	const link = graphLink(node, input.link);
	const originId = Array.isArray(link) ? link[1] : (link?.origin_id ?? link?.originId);
	const originSlot = Number(Array.isArray(link) ? link[2] : (link?.origin_slot ?? link?.originSlot));
	const graph = node?.graph ?? app?.graph;
	const origin = graph?.getNodeById?.(originId)
		?? graph?._nodes_by_id?.[originId]
		?? graph?._nodes?.find?.((item) => String(item?.id) === String(originId));
	const linkType = Array.isArray(link) ? link[5] : link?.type;
	const rememberedType = String(node.__gjjGemmaMediaSourceType || "").toUpperCase();
	const sourceType = String(origin?.outputs?.[originSlot]?.type || rememberedType || linkType || "").toUpperCase();
	const sourceTypes = sourceType.split(",").map((part) => part.trim()).filter(Boolean);
	const actualType = sourceTypes.length === 1 && ["IMAGE", "GJJ_BATCH_IMAGE", "VIDEO", "AUDIO"].includes(sourceTypes[0])
		? sourceTypes[0]
		: null;
	if (!actualType) return;
	input.type = actualType;
	input.label = actualType === "AUDIO" ? "媒体 · 音频" : `媒体 · ${actualType}`;
	input.localized_name = input.label;
	if (Array.isArray(link)) link[5] = actualType;
	else if (link) link.type = actualType;
}

function placePromptAfterPanel(node) {
	const prompt = widget(node, PROMPT_WIDGET);
	const panel = widget(node, PANEL_WIDGET);
	if (!prompt || !panel || !Array.isArray(node.widgets)) return;
	const promptIndex = node.widgets.indexOf(prompt);
	if (promptIndex >= 0) node.widgets.splice(promptIndex, 1);
	const panelIndex = Math.max(0, node.widgets.indexOf(panel));
	node.widgets.splice(panelIndex + 1, 0, prompt);
}

function compactWidgetLayout(node) {
	if (!Array.isArray(node?.widgets)) return;
	const panel = widget(node, PANEL_WIDGET);
	const prompt = widget(node, PROMPT_WIDGET);
	const visible = [];
	const hidden = [];
	for (const item of node.widgets) {
		if (!item || item === panel || item === prompt) continue;
		const isHidden = item.hidden
			|| item.__gjjUtilsHidden
			|| HIDDEN_WIDGETS.has(String(item.name || ""));
		(isHidden ? hidden : visible).push(item);
	}
	node.widgets = [panel, prompt, ...visible, ...hidden].filter(Boolean);
	for (const item of hidden) {
		item.last_y = 0;
		item.computedHeight = 0;
		item.margin_top = 0;
		item.size = [0, 0];
	}
	if (prompt) {
		prompt.last_y = 0;
		prompt.computedHeight = PROMPT_HEIGHT;
		prompt.margin_top = 0;
		prompt.size = [Math.max(260, Number(node.size?.[0] || 470)), PROMPT_HEIGHT];
	}
}

function visibleWidgetHeight(node) {
	let total = 0;
	for (const item of node?.widgets || []) {
		if (!item || item.hidden || item.__gjjUtilsHidden || HIDDEN_WIDGETS.has(String(item.name || ""))) continue;
		try {
			const size = item.computeSize?.(node.size?.[0] || 470);
			if (Array.isArray(size) && Number.isFinite(Number(size[1]))) {
				total += Math.max(0, Number(size[1]));
				continue;
			}
		} catch (_) {}
		if (Number.isFinite(Number(item.computedHeight))) total += Math.max(0, Number(item.computedHeight));
		else if (Number.isFinite(Number(item.size?.[1]))) total += Math.max(0, Number(item.size[1]));
		else total += 20;
	}
	return total;
}

function resizeNode(node, delay = 0) {
	const run = () => {
		if (!node) return;
		compactWidgetLayout(node);
		const width = Math.max(470, Number(node.size?.[0] || 470));
		const height = Math.max(92, Math.ceil(visibleWidgetHeight(node) + NODE_EXTRA_HEIGHT));
		node.setSize?.([width, height]);
		GJJ_Utils.dirtyCanvas(node);
	};
	if (delay > 0) {
		setTimeout(() => requestAnimationFrame(run), delay);
		return;
	}
	requestAnimationFrame(run);
}

function showResultPreview(node, message) {
	const payload = message?.gjj_gemma_result?.[0]
		?? message?.ui?.gjj_gemma_result?.[0];
	if (!payload || typeof payload !== "object") return;

	let state = node.__gjjGemmaResultPreview;
	const incomingModel = String(payload.model || "未知").replace(/\.(?:safetensors|gguf|bin|pt|pth|ckpt)$/i, "");
	const incomingHasResult = Object.prototype.hasOwnProperty.call(payload, "text");
	if (state && !incomingHasResult && state.model === incomingModel && state.preview.value) return;
	if (!state) {
		const root = protect(document.createElement("div"));
		root.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:5px",
			"box-sizing:border-box",
			"padding:6px 8px 8px",
			"width:100%",
			"color:var(--input-text, #ddd)",
			"font:12px/1.35 sans-serif",
		].join(";");

		const status = document.createElement("div");
		status.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.textContent = "复制";
		copy.title = "复制生成结果";
		copy.disabled = true;
		copy.style.cssText = "flex:0 0 auto;height:22px;padding:0 8px;border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#222);color:inherit;cursor:pointer";
		const summary = document.createElement("div");
		summary.style.cssText = [
			"overflow:hidden",
			"text-overflow:ellipsis",
			"white-space:nowrap",
			"opacity:.92",
		].join(";");

		const preview = document.createElement("textarea");
		preview.readOnly = true;
		preview.rows = 3;
		preview.spellcheck = false;
		preview.style.cssText = [
			"box-sizing:border-box",
			"width:100%",
			"height:58px",
			"min-height:58px",
			"max-height:58px",
			"resize:none",
			"overflow-y:auto",
			"padding:5px 7px",
			"border:1px solid var(--border-color, #555)",
			"border-radius:5px",
			"background:var(--comfy-input-bg, #222)",
			"color:var(--input-text, #ddd)",
			"font:12px/16px monospace",
			"white-space:pre-wrap",
		].join(";");
		copy.addEventListener("click", async () => {
			if (!preview.value) return;
			try {
				await navigator.clipboard.writeText(preview.value);
				copy.textContent = "已复制";
			} catch (_) {
				preview.focus();
				preview.select();
				document.execCommand?.("copy");
				copy.textContent = "已复制";
			}
			setTimeout(() => { copy.textContent = "复制"; }, 1200);
		});
		status.append(copy, summary);
		root.append(status, preview);
		preview.style.display = "none";

		const domWidget = node.addDOMWidget(RESULT_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
		});
		domWidget.computeSize = (width) => [
			Math.max(470, Number(width || node.size?.[0] || 470)),
			preview.style.display === "none" ? 36 : 92,
		];
		state = node.__gjjGemmaResultPreview = { root, summary, preview, copy, domWidget };
	}

	const elapsed = payload.elapsed ? `  ⏰ ${String(payload.elapsed)}` : "";
	state.model = incomingModel;
	state.summary.textContent = `🧠 ${incomingModel}  💾 ${String(payload.model_size || "待执行")}${elapsed}`;
	state.summary.title = state.summary.textContent;
	const hasResult = incomingHasResult;
	if (hasResult) state.preview.value = String(payload.text ?? "").replace(/\r\n/g, " ").replace(/\n/g, " ");
	state.preview.style.display = hasResult ? "" : "none";
	state.copy.disabled = !hasResult || !state.preview.value;
	state.copy.style.display = hasResult ? "" : "none";
	state.copy.style.opacity = state.copy.disabled ? ".5" : "1";
	compactWidgetLayout(node);
	resizeNode(node);
	resizeNode(node, 80);
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-ia-settings";
	const templateSettings = document.createElement("div");
	templateSettings.className = "gjj-ia-template-settings";

	const clipName = searchableSelectField("选择 ComfyUI/models/text_encoders 目录中的反推模型");
	clipName.__gjjSearchSelect.onChange = (value) => {
		setWidgetValue(node, "clip_name", value);
		syncPanel(node);
	};
	clipName.__gjjSearchSelect.onFilterChange = (value) => {
		setWidgetValue(node, MODEL_FILTER_WIDGET, value);
	};
	const clipType = selectField("传给官方 CLIPLoader 的类型");
	bindWidgetControl(node, "clip_type", clipType);
	const clipDevice = selectField("CLIP 加载设备");
	bindWidgetControl(node, "clip_device", clipDevice);
	clipDevice.addEventListener("change", () => {
		setWidgetValue(node, "device_preference", clipDevice.value === "cpu" ? "CPU优先" : "GPU优先");
		syncPanel(node);
	});

	const numeric = document.createElement("div");
	numeric.className = "gjj-ia-numeric";
	const samplingMode = selectField("开启：使用温度、Top K、Top P 等参数随机采样；关闭：始终选择当前概率最高的 token，输出更稳定。", ["on", "off"]);
	samplingMode.options[0].textContent = "开启";
	samplingMode.options[1].textContent = "关闭";
	bindWidgetControl(node, "sampling_mode", samplingMode);
	const maxLength = numericControl(node, "max_length", "最大输出 token 数。系统 TextGenerate 默认 512；值越大越容易得到完整长文，但生成更慢、占用更多显存。", 1, 32768, 1, true);
	const temperature = numericControl(node, "temperature", "控制随机程度。0.2–0.7 更稳定、忠于指令；0.8–1.2 更多样但更容易跑题。仅在随机采样开启时生效。", 0.01, 2, 0.01);
	const topK = numericControl(node, "top_k", "每一步只保留概率最高的 K 个候选。值小更稳定，值大更多样；0 表示关闭 Top K。会与 Top P、Min P 共同生效。", 0, 1000, 1, true);
	const topP = numericControl(node, "top_p", "按概率从高到低累加候选，累计达到该比例后截断。值低更集中，接近 1.0 更多样；1.0 基本不截断。", 0, 1, 0.01);
	const minP = numericControl(node, "min_p", "排除低于“最高概率 × Min P”的候选。值越高越保守；0 表示关闭，常用范围约 0.03–0.10。", 0, 1, 0.01);
	const repetitionPenalty = numericControl(node, "repetition_penalty", "降低已经生成过的 token 再次出现的概率。1.0 不惩罚；1.05–1.15 可减少复读，过高会影响连贯性。", 0, 5, 0.01);
	const presencePenalty = numericControl(node, "presence_penalty", "只要 token 已出现就施加固定惩罚，鼓励新内容。0 表示关闭；过高可能导致用词生硬或偏题。", 0, 5, 0.01);
	const seed = numericControl(node, "seed", "随机采样种子；0 表示每次自动使用新种子，非 0 表示固定结果", 0, Number.MAX_SAFE_INTEGER, 1, true);
	const samplingFields = [
		parameterField("🌡 温度", temperature),
		parameterField("🎯 Top K", topK),
		parameterField("🧭 Top P", topP),
		parameterField("⚖️ Min P", minP),
		parameterField("🚫 重复惩罚", repetitionPenalty),
		parameterField("✨ 出现惩罚", presencePenalty),
		parameterField("🔢 种子", seed),
	];
	numeric.append(
		labelledField("🎲 采样模式", samplingMode),
		parameterField("📐 最大长度", maxLength),
		...samplingFields,
	);

	const templateEditor = document.createElement("textarea");
	templateEditor.className = "gjj-ia-textarea templates";
	templateEditor.placeholder = "与 GJJ_OllamaAssistant 共用：\n【🧡反推】系统提示词正文\n\n【🎬分镜】系统提示词正文";
	protect(templateEditor);
	templateEditor.addEventListener("input", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		syncPanel(node);
	});
	const saveTemplates = button("💾", "保存到与 GJJ_OllamaAssistant 共用的预设", async () => {
		if (saveTemplates.disabled) return;
		saveTemplates.disabled = true;
		saveTemplates.textContent = "保存中";
		try {
			await saveSharedTemplates(node);
			saveTemplates.textContent = "已保存";
			saveTemplates.classList.add("active");
		} catch (error) {
			saveTemplates.textContent = "保存失败";
			saveTemplates.title = error?.message || "保存失败";
		}
		setTimeout(() => {
			saveTemplates.disabled = false;
			saveTemplates.textContent = "💾";
			saveTemplates.classList.remove("active");
		}, 1300);
	});
	saveTemplates.classList.add("compact");

	const outputRule = document.createElement("textarea");
	outputRule.className = "gjj-ia-textarea rule";
	outputRule.placeholder = "点击模板按钮时追加到模板正文之后。";
	protect(outputRule);
	outputRule.addEventListener("input", () => {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, outputRule.value);
		syncPanel(node);
	});

	const systemPrompt = document.createElement("textarea");
	systemPrompt.className = "gjj-ia-textarea";
	systemPrompt.placeholder = "点击上方模板按钮自动写入，或在这里自定义系统提示词。";
	protect(systemPrompt);
	systemPrompt.addEventListener("input", () => {
		setWidgetValue(node, "system_prompt", systemPrompt.value);
		syncPanel(node);
	});

	settings.append(numeric);
	templateSettings.append(
		labelledField("🧩 系统提示词模板", templateEditor, saveTemplates),
		labelledField("🚫 输出约束", outputRule),
		labelledField("🧾 当前系统提示词", systemPrompt),
	);
	return {
		settings,
		templateSettings,
		clipName,
		clipType,
		clipDevice,
		samplingMode,
		samplingFields,
		maxLength,
		temperature,
		topK,
		topP,
		minP,
		repetitionPenalty,
		presencePenalty,
		seed,
		templateEditor,
		saveTemplates,
		outputRule,
		systemPrompt,
	};
}

function buildModelPanel(node, controls) {
	const panel = document.createElement("div");
	panel.className = "gjj-gemma-model-panel";

	const toggleRow = document.createElement("div");
	toggleRow.className = "gjj-gemma-model-toggles";
	const gpuPriority = button("GPU优先", "使用 ComfyUI 默认 GPU 加载策略。点击切换为 CPU优先。", () => {
		setDevicePreference(node, devicePreferenceValue(node) === "GPU优先" ? "CPU优先" : "GPU优先");
		syncPanel(node);
	});
	const keepModel = button("保持模型", "开启后复用已加载模型，减少重复加载时间，但会占用显存/内存。", () => {
		setKeepModel(node, !keepModelEnabled(node));
		syncPanel(node);
	});
	const defaultTemplate = button("默认模板", "切换模型默认模板", () => {
		setWidgetValue(node, "use_default_template", !asBool(widgetValue(node, "use_default_template", true)));
		syncPanel(node);
	});
	toggleRow.append(gpuPriority, keepModel, defaultTemplate);

	const grid = document.createElement("div");
	grid.className = "gjj-gemma-model-grid";
	const modelPath = document.createElement("div");
	modelPath.className = "gjj-gemma-model-path";
	const updateModelPath = () => {
		const selected = String(widgetValue(node, "clip_name", "") || "").replaceAll("\\", "/");
		modelPath.textContent = `当前路径：models/text_encoders/${selected || "未选择模型"}`;
		modelPath.title = modelPath.textContent;
	};
	const modelFamilyFilter = (_entry = null, widget = null) => GJJ_Utils._modelTreeFamilyStem(
		widget?.value || widgetValue(node, "clip_name", ""),
	);
	const syncModelFamilyFilter = (value = widgetValue(node, "clip_name", "")) => {
		const filterValue = GJJ_Utils._modelTreeFamilyStem(value);
		if (filterValue) {
			setWidgetValue(node, MODEL_FILTER_WIDGET, filterValue);
		}
		return filterValue;
	};
	syncModelFamilyFilter();
	const modelTree = GJJ_Utils.createModelTreeView({
		node,
		entries: [{
			widget: "clip_name",
			label: "Gemma / Qwen 反推模型",
			folder: "models/text_encoders",
			icon: "🧠",
			models: choices("clip_name", node),
			searchValue: modelFamilyFilter,
			stateSearchValue: modelFamilyFilter,
			fallback: String(widgetValue(node, "clip_name", "") || "未找到匹配的反推模型"),
			description: "用于图片、视频或音频理解与文本生成；模型相对路径完整保存在工作流中。",
		}],
		refresh: () => {
			updateModelPath();
			syncPanel(node);
		},
		onApply: (_entry, value) => {
			syncModelFamilyFilter(value);
			updateModelPath();
			const state = node.__gjjGemmaPanel;
			if (state) state.modelExpanded = false;
		},
	});
	modelTree.style.maxHeight = "330px";
	updateModelPath();
	grid.append(
		modelTree,
		modelPath,
		labelledField("🧩 CLIP 类型", controls.clipType),
		labelledField("💻 加载设备", controls.clipDevice),
	);
	panel.append(toggleRow, grid);
	return { panel, gpuPriority, keepModel, defaultTemplate, modelPath, updateModelPath };
}

function renderTemplateButtons(node, config) {
	const state = node.__gjjGemmaPanel;
	if (!state || state.templateSignature === config.signature) return;
	state.templateSignature = config.signature;
	state.templateConfig = config;
	state.templates.replaceChildren();
	state.templateButtons = new Map();
	for (const item of config.templates) {
		const label = String(item.title || "模板").replace(/\s+/g, "");
		const choice = button(label, `设置系统提示词模板：${label}`, () => {
			setWidgetValue(node, "system_prompt", templatePrompt(config, item));
			state.templatesExpanded = false;
			syncPanel(node);
		});
		choice.classList.add("compact");
		state.templateButtons.set(item.key, { button: choice, item });
		state.templates.appendChild(choice);
	}
}

function readTemplateConfig(node) {
	const rawTemplates = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "").trim();
	return {
		outputRule,
		templates: parseTemplateText(rawTemplates),
		signature: JSON.stringify([rawTemplates, outputRule]),
	};
}

function syncPanel(node) {
	syncNodeTitle(node);
	const state = node.__gjjGemmaPanel;
	if (!state) return;
	const thinking = asBool(widgetValue(node, "thinking", false));
	const defaultTemplate = asBool(widgetValue(node, "use_default_template", true));
	const sampling = String(widgetValue(node, "sampling_mode", "on")) === "on";
	const keepModel = keepModelEnabled(node);
	const devicePreference = devicePreferenceValue(node);
	state.thinking.classList.toggle("active", thinking);
	state.thinking.title = thinking ? "思考模式：开。点击关闭。" : "思考模式：关。点击开启。";
	state.defaultTemplate.classList.toggle("active", defaultTemplate);
	state.defaultTemplate.title = defaultTemplate ? "模型默认模板：开。点击关闭。" : "模型默认模板：关。点击开启。";
	state.keepModel.classList.toggle("active", keepModel);
	state.keepModel.textContent = keepModel ? "保持模型" : "不保持";
	state.keepModel.title = keepModel ? "保持模型：开。点击关闭。" : "保持模型：关。点击开启。";
	state.gpuPriority.classList.toggle("active", devicePreference === "GPU优先");
	state.gpuPriority.textContent = devicePreference;
	state.gpuPriority.title = devicePreference === "GPU优先"
		? "GPU优先：使用 ComfyUI 默认 GPU 加载策略。点击切换 CPU优先。"
		: "CPU优先：强制把 CLIP/Gemma 加载到 CPU。点击切换 GPU优先。";
	state.randomSeed.classList.toggle("active", sampling);
	state.randomSeed.title = sampling ? "随机采样：开。点击关闭采样。" : "随机采样：关。点击开启采样。";
	state.settingsButton.classList.toggle("active", state.expanded);
	state.settingsButton.title = state.expanded ? "收起生成参数和提示词设置" : "展开生成参数和提示词设置";
	state.settings.style.display = state.expanded ? "flex" : "none";
	state.templateSettings.style.display = state.templatesExpanded ? "flex" : "none";
	state.templateButton.classList.toggle("active", state.templatesExpanded);
	state.templateButton.title = state.templatesExpanded ? "收起模板设置" : "展开模板设置";
	state.modelPanel.style.display = state.modelExpanded ? "flex" : "none";
	state.modelPanelButton.classList.toggle("active", state.modelExpanded);
	state.modelPanelButton.classList.toggle("keep-model-on", keepModel);
	state.modelPanelButton.classList.toggle("keep-model-off", !keepModel);
	state.modelPanelButton.title = state.modelExpanded
		? "收起模型设置"
		: `展开模型设置。${keepModel ? "保持模型已开启。" : "保持模型未开启。"}`;
	state.updateModelPath?.();
	syncSearchableSelect(
		state.clipName,
		choices("clip_name", node),
		widgetValue(node, "clip_name", ""),
		widgetValue(node, MODEL_FILTER_WIDGET, "qwen3.5|gemma4|qwen3vl"),
	);
	syncSelectOptions(state.clipType, choices("clip_type", node), widgetValue(node, "clip_type", ""));
	syncSelectOptions(state.clipDevice, choices("clip_device", node), widgetValue(node, "clip_device", ""));
	syncSelectOptions(state.samplingMode, ["on", "off"], widgetValue(node, "sampling_mode", "on"));
	state.samplingMode.options[0].textContent = "开启";
	state.samplingMode.options[1].textContent = "关闭";
	for (const field of state.samplingFields) field.style.display = sampling ? "flex" : "none";
	for (const [control, name] of [
		[state.maxLength, "max_length"],
		[state.temperature, "temperature"],
		[state.topK, "top_k"],
		[state.topP, "top_p"],
		[state.minP, "min_p"],
		[state.repetitionPenalty, "repetition_penalty"],
		[state.presencePenalty, "presence_penalty"],
		[state.seed, "seed"],
	]) syncInputValue(control, widgetValue(node, name, ""));
	syncInputValue(state.templateEditor, widgetValue(node, TEMPLATE_WIDGET, ""));
	syncInputValue(state.outputRule, widgetValue(node, OUTPUT_RULE_WIDGET, ""));
	syncInputValue(state.systemPrompt, widgetValue(node, "system_prompt", ""));
	if (state.promptEditor && document.activeElement !== state.promptEditor) {
		syncInputValue(state.promptEditor, widgetValue(node, PROMPT_WIDGET, ""));
	}

	const config = readTemplateConfig(node);
	renderTemplateButtons(node, config);
	const currentPrompt = String(widgetValue(node, "system_prompt", ""));
	for (const entry of state.templateButtons.values()) {
		entry.button.classList.toggle("active", currentPrompt === templatePrompt(config, entry.item));
	}
	resizeNode(node);
}

function closeFloatingPanels(node) {
	const state = node?.__gjjGemmaPanel;
	if (!state) return;
	state.templatesExpanded = false;
	state.modelExpanded = false;
	state.expanded = false;
	state.actorPicker?.remove();
	state.actorPicker = null;
	state.actorButton?.classList.remove("active");
	state.scenePicker?.remove();
	state.scenePicker = null;
	state.sceneButton?.classList.remove("active");
	state.scenePicker?.remove();
	state.scenePicker = null;
	state.sceneButton?.classList.remove("active");
	syncPanel(node);
}

function floatingWindowActions(node) {
	const actions = document.createElement("div");
	actions.className = "gjj-ia-window-actions";
	const confirm = button("确定", "保存当前设置并关闭窗口", () => closeFloatingPanels(node));
	const close = button("关闭", "关闭当前窗口；已修改的参数仍会保留", () => closeFloatingPanels(node));
	confirm.classList.add("active");
	actions.append(close, confirm);
	return actions;
}

function createPanel(node) {
	if (node.__gjjGemmaPanel || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-ia-panel gjj-gemma-assistant-panel";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.lg-node-widget:has(> [node-type="${NODE_TYPE}"] > canvas) {
			display:none !important;
			height:0 !important;
			min-height:0 !important;
			margin:0 !important;
			padding:0 !important;
		}
		.gjj-gemma-assistant-panel, .gjj-gemma-assistant-panel * { box-sizing:border-box; }
		.gjj-gemma-assistant-panel { position:relative; display:flex; flex-direction:column; gap:7px; width:100%; padding:2px 0 4px; overflow:visible; color:#dce6e8; font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
		.gjj-gemma-assistant-panel .gjj-ia-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:5px; overflow:visible; padding:0 0 3px; scrollbar-width:thin; }
		.gjj-gemma-assistant-panel .gjj-ia-template-settings,.gjj-gemma-assistant-panel .gjj-ia-settings,.gjj-gemma-assistant-panel .gjj-gemma-model-panel { position:absolute; z-index:1000; top:62px; left:0; width:100%; max-height:min(520px,70vh); overflow:auto; box-shadow:0 12px 32px rgba(0,0,0,.55); }
		.gjj-gemma-assistant-panel .gjj-ia-templates { display:flex; flex-wrap:wrap; align-items:center; gap:4px; width:100%; min-width:0; overflow:visible; padding:1px 0 3px; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-chips { display:none; flex-wrap:wrap; align-items:center; gap:5px; padding:2px 0; }
		.gjj-gemma-assistant-panel .gjj-gemma-prompt-editor { display:block; width:100%; height:74px; min-height:74px; box-sizing:border-box; resize:vertical; border:1px solid #334850; border-radius:7px; background:#10181c; color:#eef5f5; padding:7px 9px; outline:none; font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; }
		.gjj-gemma-assistant-panel .gjj-gemma-prompt-editor:focus { border-color:#6a9dae; background:#111e23; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-chip { display:flex; align-items:center; gap:5px; min-height:28px; padding:2px 8px 2px 3px; border:1px solid #4f7b68; border-radius:999px; background:#173126; color:#eafff3; cursor:pointer; font:700 11px/1.2 system-ui,sans-serif; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-chip.dragging { opacity:.42; cursor:grabbing; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-chip.drag-over { border-color:#ffd166; box-shadow:0 0 0 2px rgba(255,209,102,.32); }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-chip img { width:23px; height:23px; border-radius:50%; object-fit:cover; background:#0c1518; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-picker { position:absolute; z-index:1002; top:34px; left:0; width:min(420px,100%); max-height:min(430px,70vh); overflow:hidden; display:flex; flex-direction:column; gap:6px; padding:7px; border:1px solid #526a73; border-radius:8px; background:rgba(13,22,25,.98); box-shadow:0 12px 32px rgba(0,0,0,.58); }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-tools { flex:0 0 auto; display:flex; align-items:center; gap:5px; padding-bottom:5px; border-bottom:1px solid rgba(82,106,115,.45); }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-tools > :last-child { margin-left:auto; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-keyword-filter { flex:1 1 150px; min-width:90px; height:27px; box-sizing:border-box; border:1px solid #40575f; border-radius:6px; background:#0c1519; color:#edf7f4; padding:3px 7px; outline:none; font:11px/1.3 system-ui,sans-serif; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-keyword-filter:focus { border-color:#6fc696; box-shadow:0 0 0 1px rgba(111,198,150,.25); }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-grid { flex:1 1 auto; min-height:70px; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(58px,1fr)); align-content:start; gap:3px; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item { position:relative; min-width:0; height:72px; padding:0; overflow:hidden; border:0; border-radius:5px; background:#091114; color:#fff; cursor:pointer; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item:hover,.gjj-gemma-assistant-panel .gjj-gemma-actor-item.active { outline:2px solid #6fc696; outline-offset:-2px; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item.active { box-shadow:0 0 0 1px rgba(111,198,150,.45) inset; background:rgba(31,81,49,.42); }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item.active::after { content:"✓"; position:absolute; top:2px; right:4px; z-index:2; color:#9be0b5; font-size:11px; font-weight:900; text-shadow:0 1px 2px #000; pointer-events:none; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item img { display:block; width:100%; height:100%; object-fit:cover; background:#091114; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-item span { position:absolute; left:0; right:0; bottom:0; display:block; padding:12px 3px 3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:linear-gradient(transparent,rgba(0,0,0,.88)); color:#fff; text-align:center; font-size:10px; font-weight:800; text-shadow:0 1px 2px #000; }
		.gjj-gemma-assistant-panel .gjj-gemma-actor-empty { grid-column:1/-1; padding:18px; color:#93a8ad; text-align:center; }
		.gjj-gemma-actor-preview { position:fixed; z-index:100003; width:280px; max-height:380px; padding:7px; border:1px solid #628278; border-radius:9px; background:#0d171b; color:#eaf6f1; box-shadow:0 16px 38px rgba(0,0,0,.64); pointer-events:none; font:12px/1.4 system-ui,sans-serif; }
		.gjj-gemma-actor-preview img { display:block; width:100%; max-height:320px; object-fit:contain; border-radius:6px; background:#071014; }
		.gjj-gemma-actor-preview div { padding:6px 3px 1px; overflow-wrap:anywhere; }
		.gjj-gemma-mention-menu { position:fixed; z-index:100004; max-height:270px; overflow:auto; display:flex; flex-direction:column; gap:3px; padding:6px; border:1px solid #58746d; border-radius:8px; background:rgba(13,22,25,.98); color:#eaf6f1; box-shadow:0 16px 38px rgba(0,0,0,.62); font:12px/1.35 system-ui,sans-serif; }
		.gjj-gemma-mention-title { padding:3px 6px 5px; color:#9fc8bd; font-size:11px; font-weight:800; }
		.gjj-gemma-mention-empty { padding:10px 8px; color:#91a6aa; text-align:center; }
		.gjj-gemma-mention-item { width:100%; min-height:42px; display:grid; grid-template-columns:34px minmax(0,1fr); gap:7px; align-items:center; border:0; border-radius:6px; background:transparent; color:#eaf6f1; padding:4px 6px; text-align:left; cursor:pointer; }
		.gjj-gemma-mention-item:hover,.gjj-gemma-mention-item.active { background:rgba(111,198,150,.18); }
		.gjj-gemma-mention-item img { width:34px; height:34px; border-radius:50%; object-fit:cover; background:#071014; }
		.gjj-gemma-mention-main { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; }
		.gjj-gemma-mention-detail { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; color:#9fb0b5; font-size:11px; }
		.gjj-gemma-assistant-panel .gjj-ia-template-settings { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(73,93,101,.7); border-radius:9px; background:rgba(15,22,26,.96); }
		.gjj-gemma-assistant-panel .gjj-ia-window-actions { display:flex; justify-content:flex-end; align-items:center; gap:6px; padding-top:2px; border-top:1px solid rgba(73,93,101,.45); }
		.gjj-gemma-assistant-panel .gjj-ia-button { flex:0 0 auto; height:27px; padding:0 9px; border:1px solid #3d5159; border-radius:6px; background:#172127; color:#dbe6e9; font:700 12px/25px system-ui,sans-serif; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
		.gjj-gemma-assistant-panel .gjj-ia-button.compact { width:auto; min-width:28px; max-width:74px; height:22px; padding:0 7px; font-size:11px; line-height:20px; }
		.gjj-gemma-assistant-panel .gjj-ia-button:disabled { opacity:.72; cursor:wait; }
		.gjj-gemma-assistant-panel .gjj-ia-button:hover { background:#24333b; border-color:#5f8590; }
		.gjj-gemma-assistant-panel .gjj-ia-button.active { background:#24452d; border-color:#65a271; color:#ebffee; }
		.gjj-gemma-assistant-panel .gjj-ia-button.keep-model-off { background:#272127; border-color:#66505f; color:#e4d9df; }
		.gjj-gemma-assistant-panel .gjj-ia-button.keep-model-on { background:#1f5131; border-color:#72c58a; color:#f0fff4; box-shadow:0 0 0 1px rgba(114,197,138,.18) inset; }
		.gjj-gemma-assistant-panel .gjj-ia-button.keep-model-on:hover { background:#28633d; border-color:#91d8a4; }
		.gjj-gemma-assistant-panel .gjj-ia-settings { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(73,93,101,.7); border-radius:9px; background:rgba(15,22,26,.96); }
		.gjj-gemma-assistant-panel .gjj-gemma-model-panel { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(91,121,130,.78); border-radius:8px; background:rgba(13,22,25,.97); }
		.gjj-gemma-assistant-panel .gjj-gemma-model-toggles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
		.gjj-gemma-assistant-panel .gjj-gemma-model-toggles .gjj-ia-button { width:100%; max-width:none; text-align:center; }
		.gjj-gemma-assistant-panel .gjj-gemma-model-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:7px; }
		.gjj-gemma-assistant-panel .gjj-gemma-model-path { padding:5px 7px; border:1px solid #33454c; border-radius:6px; background:#0d1519; color:#9fc8bd; font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
		.gjj-gemma-assistant-panel .gjj-ia-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-label { color:#aebfc4; font-weight:700; font-size:11px; letter-spacing:.02em; }
		.gjj-gemma-assistant-panel .gjj-ia-label-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-input,.gjj-gemma-assistant-panel .gjj-ia-textarea { width:100%; border:1px solid #334850; border-radius:6px; background:#10181c; color:#eef5f5; padding:5px 7px; outline:none; font:12px/1.4 system-ui,sans-serif; }
		.gjj-gemma-assistant-panel .gjj-ia-input { height:29px; }
		.gjj-gemma-assistant-panel .gjj-ia-search-select { position:relative; width:100%; min-width:0; }
		.gjj-gemma-assistant-panel .gjj-ia-search-trigger { display:block; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:24px; }
		.gjj-gemma-assistant-panel .gjj-ia-search-trigger::after { content:"▾"; position:absolute; right:9px; color:#91a5ab; }
		.gjj-gemma-assistant-panel .gjj-ia-input:focus,.gjj-gemma-assistant-panel .gjj-ia-textarea:focus { border-color:#6a9dae; background:#111e23; }
		.gjj-gemma-assistant-panel .gjj-ia-numeric { display:grid; grid-template-columns:minmax(0,1fr); gap:7px; width:100%; }
		.gjj-gemma-assistant-panel .gjj-ia-param { width:100%; min-width:0; max-width:none; display:flex; flex-direction:row; align-items:center; gap:6px; padding:5px 6px; border:1px solid rgba(51,72,80,.72); border-radius:6px; background:rgba(16,24,28,.58); }
		.gjj-gemma-assistant-panel .gjj-ia-param .gjj-ia-label { flex:0 0 auto; max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-gemma-assistant-panel .gjj-ia-param .gjj-ia-input { flex:1 1 54px; min-width:50px; height:27px; padding:4px 6px; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea { min-height:86px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea.rule { min-height:48px; }
		.gjj-gemma-assistant-panel .gjj-ia-textarea.templates { height:118px; min-height:48px; max-height:none; overflow:auto; resize:vertical; }
		.gjj-ia-search-popup { position:fixed; z-index:100000; display:flex; flex-direction:column; gap:5px; max-height:360px; padding:7px; border:1px solid #526a73; border-radius:8px; background:#10181c; box-shadow:0 12px 32px rgba(0,0,0,.55); color:#eef5f5; font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
		.gjj-ia-search-filter { flex:0 0 auto; }
		.gjj-ia-search-hint { flex:0 0 auto; color:#8fa2a8; font-size:10px; padding:0 2px; }
		.gjj-ia-search-list { display:flex; flex-direction:column; min-height:36px; overflow:auto; border-top:1px solid rgba(82,106,115,.45); padding-top:4px; }
		.gjj-ia-search-option { flex:0 0 auto; width:100%; min-height:28px; border:0; border-radius:4px; background:transparent; color:#dce7e9; padding:5px 7px; text-align:left; cursor:pointer; white-space:normal; word-break:break-all; }
		.gjj-ia-search-option:hover { background:#25363d; color:#fff; }
		.gjj-ia-search-option.active { background:#24452d; color:#ebffee; }
		.gjj-ia-search-empty { color:#8fa2a8; padding:10px 7px; text-align:center; }
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-ia-toolbar";
	const templates = document.createElement("div");
	templates.className = "gjj-ia-templates";
	const actorChips = document.createElement("div");
	actorChips.className = "gjj-gemma-actor-chips";
	const sceneChips = document.createElement("div");
	sceneChips.className = "gjj-gemma-actor-chips";
	const promptEditor = document.createElement("textarea");
	promptEditor.className = "gjj-gemma-prompt-editor";
	promptEditor.placeholder = "输入指令 / 原文；也可连接外部 STRING";
	promptEditor.title = "发送给 Gemma 的用户指令 / 原文";
	promptEditor.addEventListener("input", () => {
		const target = widget(node, PROMPT_WIDGET);
		if (target) target.value = promptEditor.value;
		markChanged(node);
	});
	promptEditor.addEventListener("change", () => setWidgetValue(node, PROMPT_WIDGET, promptEditor.value));
	promptEditor.addEventListener("keydown", (event) => event.stopPropagation());
	bindActorMentionEditor(node, promptEditor);
	const actorButton = button("👤", "选择参与演员", () => {
		toggleActorPicker(node).catch((error) => alert(`读取角色库失败：${error?.message || error}`));
	});
	const sceneButton = button("🏕️", "选择引用场景", () => {
		toggleScenePicker(node).catch((error) => alert(`读取场景库失败：${error?.message || error}`));
	});
	const templateButton = button("📚", "展开模板设置", () => {
		const state = node.__gjjGemmaPanel;
		const open = !state.templatesExpanded;
		state.templatesExpanded = open;
		state.modelExpanded = false;
		state.expanded = false;
		syncPanel(node);
	});
	const thinking = button("💭", "切换思考模式", () => {
		setWidgetValue(node, "thinking", !asBool(widgetValue(node, "thinking", false)));
		syncPanel(node);
	});
	const modelPanelButton = button("🧠", "展开模型设置", () => {
		const state = node.__gjjGemmaPanel;
		const open = !state.modelExpanded;
		state.modelExpanded = open;
		state.templatesExpanded = false;
		state.expanded = false;
		syncPanel(node);
	});
	const randomSeed = button("🎲", "切换随机采样", () => {
		const enabled = String(widgetValue(node, "sampling_mode", "on")) === "on";
		setWidgetValue(node, "sampling_mode", enabled ? "off" : "on");
		syncPanel(node);
	});
	const settingsButton = button("⚙️", "展开生成参数和提示词设置", () => {
		const state = node.__gjjGemmaPanel;
		const open = !state.expanded;
		state.expanded = open;
		state.templatesExpanded = false;
		state.modelExpanded = false;
		syncPanel(node);
	});
	const runButton = button("▶️", "只执行当前 Gemma 文本生成节点", async () => {
		if (runButton.disabled) return;
		runButton.disabled = true;
		runButton.textContent = "⏳";
		try {
			const queued = await queueOnlyCurrentNode(node);
			if (!queued) throw new Error("当前节点未能加入执行队列");
		} catch (error) {
			console.error("[GJJ GemmaTextGenerate] 执行当前节点失败：", error);
			alert(`执行当前节点失败：${error?.message || error}`);
		} finally {
			runButton.textContent = "▶️";
			runButton.disabled = false;
		}
	});
	toolbar.append(actorButton, sceneButton, templateButton, thinking, modelPanelButton, randomSeed, settingsButton, runButton);

	const settingsState = buildSettings(node);
	const modelState = buildModelPanel(node, settingsState);
	settingsState.templateSettings.appendChild(floatingWindowActions(node));
	modelState.panel.appendChild(floatingWindowActions(node));
	settingsState.settings.appendChild(floatingWindowActions(node));
	root.append(style, toolbar, templates, actorChips, sceneChips, promptEditor, settingsState.templateSettings, modelState.panel, settingsState.settings);
	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	domWidget.computeSize = (width) => {
		const toolbarHeight = Number(toolbar.offsetHeight || 30);
		const actorRowHeight = actorChips.style.display === "none" ? 0 : Number(actorChips.offsetHeight || 30);
		const sceneRowHeight = sceneChips.style.display === "none" ? 0 : Number(sceneChips.offsetHeight || 30);
		const templateRowHeight = Number(templates.offsetHeight || 25);
		const promptHeight = Number(promptEditor.offsetHeight || PROMPT_HEIGHT);
		const mainPanelHeight = Math.ceil(toolbarHeight + actorRowHeight + sceneRowHeight + templateRowHeight + promptHeight + 19);
		return [
			Math.max(470, Number(width || node.size?.[0] || 470)),
			Math.max(35, mainPanelHeight),
		];
	};
	node.__gjjGemmaPanel = {
		root,
		domWidget,
		actorButton,
		actorChips,
		actorPicker: null,
		promptEditor,
		sceneButton,
		sceneChips,
		scenePicker: null,
		templates,
		templateButtons: new Map(),
		templateButton,
		templateSettings: settingsState.templateSettings,
		templatesExpanded: false,
		thinking,
		modelPanelButton,
		modelPanel: modelState.panel,
		gpuPriority: modelState.gpuPriority,
		keepModel: modelState.keepModel,
		defaultTemplate: modelState.defaultTemplate,
		modelPath: modelState.modelPath,
		updateModelPath: modelState.updateModelPath,
		randomSeed,
		settingsButton,
		expanded: false,
		modelExpanded: false,
		...settingsState,
	};
	const index = node.widgets?.indexOf(domWidget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(domWidget);
	}
	const handleOutsidePointerDown = (event) => {
		const state = node.__gjjGemmaPanel;
		if (!state || (!state.templatesExpanded && !state.modelExpanded && !state.expanded && !state.actorPicker && !state.scenePicker)) return;
		if (root.contains(event.target)) return;
		if (event.target?.closest?.(".gjj-ia-search-popup")) return;
		closeFloatingPanels(node);
	};
	document.addEventListener("pointerdown", handleOutsidePointerDown, true);
	const originalOnRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
		if (this.__gjjGemmaActorTriggerHandler) {
			for (const eventName of ["input", "click", "keyup", "select"]) {
				document.removeEventListener(eventName, this.__gjjGemmaActorTriggerHandler, true);
			}
			this.__gjjGemmaActorTriggerHandler = null;
		}
		try { this.__gjjGemmaPanel?.actorPicker?.remove(); } catch (_) {}
		try { this.__gjjGemmaPanel?.scenePicker?.remove(); } catch (_) {}
		closeFloatingPreview();
		try { clipName.__gjjSearchSelectPopup?.remove(); } catch (_) {}
		return originalOnRemoved?.apply(this, args);
	};
	loadSharedSettings().then((settings) => {
		const currentTemplates = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
		if (!parseTemplateText(currentTemplates).length && settings.templateText) {
			setWidgetValue(node, TEMPLATE_WIDGET, settings.templateText);
		}
		if (!String(widgetValue(node, OUTPUT_RULE_WIDGET, "") || "").trim() && settings.outputRule) {
			setWidgetValue(node, OUTPUT_RULE_WIDGET, settings.outputRule);
		}
		syncPanel(node);
	});
	const restoredActors = selectedActors(node);
	if (restoredActors.length) saveActors(node, restoredActors);
	else renderActorChips(node);
	const restoredScenes = selectedScenes(node);
	if (restoredScenes.length) saveScenes(node, restoredScenes);
	else renderSceneChips(node);
	syncPanel(node);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) return;
	const templateText = String(widgetValue(node, TEMPLATE_WIDGET, "") || "");
	const migratedTemplateText = migrateLegacyTemplateText(templateText);
	if (migratedTemplateText !== templateText) {
		setWidgetValue(node, TEMPLATE_WIDGET, migratedTemplateText);
	}
	const systemPrompt = String(widgetValue(node, "system_prompt", "") || "");
	const migratedSystemPrompt = migrateLegacyTemplateText(systemPrompt);
	if (migratedSystemPrompt !== systemPrompt) {
		setWidgetValue(node, "system_prompt", migratedSystemPrompt);
	}
	node.properties ||= {};
	if (!node.properties[CLIP_TYPE_REFERENCE_MIGRATION]) {
		const currentClipType = String(widgetValue(node, "clip_type", "") || "");
		const currentClipName = String(widgetValue(node, "clip_name", "") || "").toLowerCase();
		if (
			currentClipType === "ideogram4"
			&& (currentClipName.includes("qwen3.5") || currentClipName.includes("qwen35") || currentClipName.includes("qwen3vl"))
		) {
			setWidgetValue(node, "clip_type", "stable_diffusion");
		}
		node.properties[CLIP_TYPE_REFERENCE_MIGRATION] = true;
	}
	if (!String(widgetValue(node, "device_preference", "") || "").trim()) {
		setWidgetValue(node, "device_preference", String(widgetValue(node, "clip_device", "default")) === "cpu" ? "CPU优先" : "GPU优先");
	}
	if (widgetValue(node, "keep_model", undefined) === undefined) {
		setWidgetValue(node, "keep_model", true);
	}
	const thinkingWidget = widget(node, "thinking");
	if (thinkingWidget) {
		thinkingWidget.value = asBool(thinkingWidget.value);
		thinkingWidget.serializeValue = () => asBool(thinkingWidget.value);
	}
	const defaultTemplateWidget = widget(node, "use_default_template");
	if (defaultTemplateWidget) {
		defaultTemplateWidget.value = asBool(defaultTemplateWidget.value);
		defaultTemplateWidget.serializeValue = () => asBool(defaultTemplateWidget.value);
	}
	if (repairMissingClipName(node)) rememberWorkflowValues(node);
	hideBackendWidgets(node);
	createPanel(node);
	showResultPreview(node, {
		gjj_gemma_result: [{
			model: widgetValue(node, "clip_name", "未知"),
			model_size: "待执行",
		}],
	});
	loadModelSizes().then((sizes) => {
		const model = String(widgetValue(node, "clip_name", "未知") || "未知");
		const bytes = Number(sizes?.[model] || 0);
		showResultPreview(node, {
			gjj_gemma_result: [{
				model,
				model_size: bytes > 0 ? `${(bytes / (1024 ** 3)).toFixed(2)} GB` : "未知",
			}],
		});
	});
	hideNativePromptWidget(node);
	installActorPromptTrigger(node);
	normalizeMediaInput(node);
	ensurePromptInput(node);
	syncMediaInputRoute(node);
	placePromptAfterPanel(node);
	syncPanel(node);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.GemmaTextGenerate",
	beforeQueuePrompt() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) continue;
			const thinkingWidget = widget(node, "thinking");
			if (thinkingWidget) thinkingWidget.value = asBool(thinkingWidget.value);
			const defaultTemplateWidget = widget(node, "use_default_template");
			if (defaultTemplateWidget) defaultTemplateWidget.value = asBool(defaultTemplateWidget.value);
			rememberWorkflowValues(node);
		}
	},
	beforeQueued() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) rememberWorkflowValues(node);
		}
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 80);
			schedule(this, 1200);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreWorkflowValues(this, serializedNode);
			schedule(this);
			schedule(this, 80);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			repairMissingClipName(this);
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			rememberWorkflowValues(this, serializedNode);
			return result;
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const link = args[3];
			const targetSlot = Number(Array.isArray(link) ? link[4] : (link?.target_slot ?? link?.targetSlot));
			const mediaSlot = this.inputs?.findIndex?.((input) =>
				String(input?.name || "") === MEDIA_INPUT || LEGACY_MEDIA_INPUTS.has(String(input?.name || "")));
			if (mediaSlot >= 0 && targetSlot === mediaSlot) {
				const connected = args[2] !== false && link != null;
				if (connected) {
					const originId = Array.isArray(link) ? link[1] : (link?.origin_id ?? link?.originId);
					const originSlot = Number(Array.isArray(link) ? link[2] : (link?.origin_slot ?? link?.originSlot));
					const graph = this.graph ?? app?.graph;
					const origin = graph?.getNodeById?.(originId)
						?? graph?._nodes_by_id?.[originId]
						?? graph?._nodes?.find?.((item) => String(item?.id) === String(originId));
					this.__gjjGemmaMediaSourceType = String(origin?.outputs?.[originSlot]?.type || "");
				} else {
					this.__gjjGemmaMediaSourceType = "";
				}
			}
			schedule(this);
			return result;
		};
		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			showResultPreview(this, message);
			return result;
		};
	},
	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) schedule(node);
	},
});

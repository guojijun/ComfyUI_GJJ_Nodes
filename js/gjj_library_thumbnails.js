const CHARACTER_THUMBNAIL_ENDPOINT = "/gjj/character_library/thumbnail";
const SCENE_THUMBNAIL_ENDPOINT = "/gjj/scene_library/thumbnail";
const thumbnailBlobCache = new Map();
const thumbnailQueue = [];
let activeThumbnailLoads = 0;
const THUMBNAIL_CONCURRENCY = 4;

function drainThumbnailQueue() {
	while (activeThumbnailLoads < THUMBNAIL_CONCURRENCY && thumbnailQueue.length) {
		const task = thumbnailQueue.shift();
		activeThumbnailLoads += 1;
		void task().finally(() => {
			activeThumbnailLoads -= 1;
			drainThumbnailQueue();
		});
	}
}

function itemId(itemOrId) {
	if (itemOrId && typeof itemOrId === "object") {
		return String(itemOrId.id || itemOrId._folder_id || itemOrId.name || "").trim();
	}
	return String(itemOrId || "").trim();
}

export function gjjCharacterThumbnailPath(character) {
	const id = itemId(character);
	return id ? `${CHARACTER_THUMBNAIL_ENDPOINT}/${encodeURIComponent(id)}.png` : "";
}

export function gjjSceneThumbnailPath(scene) {
	const id = itemId(scene);
	return id ? `${SCENE_THUMBNAIL_ENDPOINT}/${encodeURIComponent(id)}.jpg` : "";
}

export function gjjLibraryThumbnailPath(kind, item) {
	return String(kind || "").toLowerCase() === "scene"
		? gjjSceneThumbnailPath(item)
		: gjjCharacterThumbnailPath(item);
}

export function gjjLibraryThumbnailUrl(api, kind, item) {
	const path = gjjLibraryThumbnailPath(kind, item);
	return path && api?.apiURL ? api.apiURL(path) : path;
}

export function loadGjjLibraryThumbnailBlobUrl(api, kind, item) {
	const url = gjjLibraryThumbnailUrl(api, kind, item);
	if (!url) return Promise.resolve("");
	if (thumbnailBlobCache.has(url)) return thumbnailBlobCache.get(url);
	const pending = new Promise((resolve) => {
		thumbnailQueue.push(async () => {
			try {
				const response = await fetch(url, { cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				resolve(URL.createObjectURL(await response.blob()));
			} catch (_) {
				thumbnailBlobCache.delete(url);
				resolve("");
			}
		});
		drainThumbnailQueue();
	});
	thumbnailBlobCache.set(url, pending);
	return pending;
}

export function setGjjLibraryThumbnail(image, api, kind, item) {
	if (!image) return "";
	const url = gjjLibraryThumbnailUrl(api, kind, item);
	if (url) {
		void loadGjjLibraryThumbnailBlobUrl(api, kind, item).then((blobUrl) => {
			image.src = blobUrl || url;
		});
	}
	else image.removeAttribute("src");
	return url;
}

globalThis.GJJ_LibraryThumbnails = Object.freeze({
	characterPath: gjjCharacterThumbnailPath,
	scenePath: gjjSceneThumbnailPath,
	path: gjjLibraryThumbnailPath,
	load: loadGjjLibraryThumbnailBlobUrl,
});

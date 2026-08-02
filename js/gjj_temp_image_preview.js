const ENSURE_IMAGE_PREVIEW_API = "/gjj/temp_files/ensure_image_preview";
const ensuredPreviewCache = new Map();
const fullImageCache = new Map();
const previewBlobUrlCache = new Map();
const previewBlobQueue = [];
let activePreviewBlobLoads = 0;
const PREVIEW_BLOB_CONCURRENCY = 3;
const FULL_IMAGE_CACHE_LIMIT = 48;
export const GJJ_TEMP_MEDIA_TYPE = "temp";
export const GJJ_TEMP_MEDIA_SUBFOLDER = "GJJ";

function drainPreviewBlobQueue() {
	while (activePreviewBlobLoads < PREVIEW_BLOB_CONCURRENCY && previewBlobQueue.length) {
		const task = previewBlobQueue.shift();
		activePreviewBlobLoads += 1;
		void task().finally(() => {
			activePreviewBlobLoads -= 1;
			drainPreviewBlobQueue();
		});
	}
}

export function loadGjjPreviewBlobUrl(url) {
	const target = String(url || "");
	if (!target || /^(?:data:|blob:)/i.test(target)) return Promise.resolve(target);
	if (previewBlobUrlCache.has(target)) return previewBlobUrlCache.get(target);
	const pending = new Promise((resolve) => {
		previewBlobQueue.push(async () => {
			try {
				const response = await fetch(target, { cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				resolve(URL.createObjectURL(await response.blob()));
			} catch (_) {
				previewBlobUrlCache.delete(target);
				resolve("");
			}
		});
		drainPreviewBlobQueue();
	});
	previewBlobUrlCache.set(target, pending);
	return pending;
}

export function isGjjTempMediaItem(item) {
	return Boolean(
		item?.filename
		&& String(item.type || GJJ_TEMP_MEDIA_TYPE) === GJJ_TEMP_MEDIA_TYPE
		&& String(item.subfolder || "") === GJJ_TEMP_MEDIA_SUBFOLDER
	);
}

export function gjjTempImagePreviewFilename(filename) {
	const original = String(filename || "");
	if (!original) return "";
	if (/\.jpe?g$/i.test(original)) return original.replace(/\.jpe?g$/i, "_preview.jpg");
	if (/\.[^.]+$/.test(original)) return original.replace(/\.[^.]+$/, ".jpg");
	return `${original}.jpg`;
}

export function gjjTempImagePreviewItem(item) {
	if (!item?.filename) return null;
	// Only temp/GJJ files need the managed JPG proxy. Persistent output images are
	// already browser-readable and their auxiliary preview_filename can outlive a
	// stale /view response after refresh. Use the original output file so every
	// consumer (Storyboard canvas, AnyPreview tiles and the full-image overlay)
	// resolves the same durable image.
	const usesManagedPreview = isGjjTempMediaItem(item);
	return {
		filename: usesManagedPreview
			? (item.preview_filename || gjjTempImagePreviewFilename(item.filename))
			: item.filename,
		subfolder: usesManagedPreview
			? (item.preview_subfolder ?? item.subfolder ?? "")
			: (item.subfolder ?? ""),
		type: usesManagedPreview
			? (item.preview_type ?? item.type ?? GJJ_TEMP_MEDIA_TYPE)
			: (item.type ?? GJJ_TEMP_MEDIA_TYPE),
	};
}

export function gjjTempImageOriginalItem(item) {
	if (!item?.filename && !item?.original_filename) return null;
	return {
		...item,
		filename: item.original_filename || item.filename,
		subfolder: item.original_subfolder ?? item.subfolder ?? "",
		type: item.original_type ?? item.type ?? GJJ_TEMP_MEDIA_TYPE,
	};
}

export function gjjPersistentPreviewCacheItem(item) {
	if (!item?.filename || !isGjjTempMediaItem(item)) return null;
	return {
		...item,
		filename: String(item.original_filename || item.filename),
		subfolder: "GJJ/PreviewCache",
		type: "output",
		original_filename: String(item.original_filename || item.filename),
		original_subfolder: "GJJ/PreviewCache",
		original_type: "output",
	};
}

export async function ensureGjjTempImagePreview(api, item) {
	if (!isGjjTempMediaItem(item)) return null;
	const key = [item.filename, item.subfolder || GJJ_TEMP_MEDIA_SUBFOLDER, item.type || GJJ_TEMP_MEDIA_TYPE].join("\u001f");
	if (ensuredPreviewCache.has(key)) return ensuredPreviewCache.get(key);
	const pending = (async () => {
		try {
			const response = await api.fetchApi(ENSURE_IMAGE_PREVIEW_API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filename: item.filename,
					subfolder: item.subfolder || GJJ_TEMP_MEDIA_SUBFOLDER,
					type: item.type || GJJ_TEMP_MEDIA_TYPE,
				}),
			});
			const data = await response.json().catch(() => ({}));
			return response.ok && data?.image?.preview_filename ? data.image : null;
		} catch (_) {
			ensuredPreviewCache.delete(key);
			return null;
		}
	})();
	ensuredPreviewCache.set(key, pending);
	return pending;
}

export function preloadGjjFullImage(url, priority = "low") {
	const target = String(url || "");
	if (!target) return Promise.resolve(null);
	if (fullImageCache.has(target)) return fullImageCache.get(target);
	const pending = new Promise((resolve) => {
		const image = new Image();
		image.decoding = "async";
		image.fetchPriority = priority;
		image.onload = () => resolve({ url: target, image });
		image.onerror = () => {
			fullImageCache.delete(target);
			resolve(null);
		};
		image.src = target;
	});
	fullImageCache.set(target, pending);
	while (fullImageCache.size > FULL_IMAGE_CACHE_LIMIT) {
		fullImageCache.delete(fullImageCache.keys().next().value);
	}
	return pending;
}

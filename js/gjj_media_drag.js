export const GJJ_MEDIA_DRAG_MIME = "application/x-gjj-any-preview-media";

function mediaDragPayload(payloadProvider) {
	const payload = typeof payloadProvider === "function" ? payloadProvider() : payloadProvider;
	return payload?.filename ? { ...payload } : null;
}

export function bindGjjMediaDrag(element, payloadProvider) {
	if (!element?.addEventListener || element.__gjjMediaDragBound) return element;
	element.__gjjMediaDragBound = true;
	element.draggable = true;
	element.classList?.add("gjj-media-drag-source");
	element.style.cursor = "grab";
	element.style.userSelect = "none";
	element.style.webkitUserDrag = "element";
	if (!element.title) element.title = "拖到空白画布新建任意对象预览器，或拖到已有预览器";
	element.addEventListener("pointerdown", (event) => {
		if (Number(event?.button || 0) === 0) event.stopPropagation();
	});
	element.addEventListener("dragstart", (event) => {
		const payload = mediaDragPayload(payloadProvider);
		if (!payload?.filename || !event.dataTransfer) {
			event.preventDefault();
			return;
		}
		element.dataset.gjjMediaDragging = "true";
		element.style.cursor = "grabbing";
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData(GJJ_MEDIA_DRAG_MIME, JSON.stringify(payload));
	});
	element.addEventListener("dragend", () => {
		delete element.dataset.gjjMediaDragging;
		element.style.cursor = "grab";
	});
	return element;
}

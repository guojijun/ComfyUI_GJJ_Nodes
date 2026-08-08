import { app } from "/scripts/app.js";

const EXTENSION_NAME = "GJJ.AssetLibraryVideoPlayback";

function isGjjOwnedVideo(video) {
	return Boolean(video?.closest?.("[class*='gjj-'],[id^='gjj-']"));
}

function videoFromPointerEvent(event) {
	for (const target of event.composedPath?.() || []) {
		if (target instanceof HTMLVideoElement) return target;
	}
	return event.target instanceof HTMLVideoElement ? event.target : null;
}

function startNativeAssetVideo(event) {
	if (event.button !== 0) return;
	const video = videoFromPointerEvent(event);
	if (!video || isGjjOwnedVideo(video) || !video.paused) return;
	if (video.ended) video.currentTime = 0;
	// ComfyUI's MediaVideoTop calls play() from click and silently discards failures.
	// Starting on pointerdown preserves the original browser user activation. Its
	// own play handler then updates isPlaying and lets Vue expose native controls.
	void video.play().catch((error) => {
		console.warn("[GJJ Asset Video] 资产视频播放失败：", error);
	});
}

function installAssetVideoPlaybackFix() {
	if (globalThis.__gjjAssetVideoPlaybackFix) return;
	globalThis.__gjjAssetVideoPlaybackFix = true;
	window.addEventListener("pointerdown", startNativeAssetVideo, true);
}

app.registerExtension({
	name: EXTENSION_NAME,
	setup: installAssetVideoPlaybackFix,
});

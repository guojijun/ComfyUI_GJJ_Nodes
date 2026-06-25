import { app } from "/scripts/app.js";

let clearMovingTimer = null;
let pointerIsDown = false;

function setGroupMoving(value) {
	const canvas = app?.canvas;
	if (!canvas) return;
	canvas.selected_group_moving = Boolean(value);
}

function scheduleClearMoving(delay = 350) {
	if (clearMovingTimer) clearTimeout(clearMovingTimer);
	clearMovingTimer = setTimeout(() => {
		if (!pointerIsDown) setGroupMoving(false);
		clearMovingTimer = null;
	}, delay);
}

function markPointerDown() {
	pointerIsDown = true;
}

function markPointerUp() {
	pointerIsDown = false;
	scheduleClearMoving(80);
}

function numberPair(value) {
	return Array.isArray(value) || (value && typeof value.length === "number")
		? [Number(value[0] || 0), Number(value[1] || 0)]
		: [0, 0];
}

function snapshotGroupNodes(group) {
	const nodes = Array.isArray(group?._nodes) ? group._nodes.filter(Boolean) : [];
	return nodes
		.filter((node) => Array.isArray(node?.pos) || (node?.pos && typeof node.pos.length === "number"))
		.map((node) => {
			const [x, y] = numberPair(node.pos);
			return { node, x, y };
		});
}

function correctMovedNodes(snapshot, dx, dy) {
	if (!snapshot.length || (!dx && !dy)) return;
	for (const item of snapshot) {
		const node = item.node;
		if (!node?.pos) continue;
		node.pos[0] = item.x + dx;
		node.pos[1] = item.y + dy;
	}
	app?.graph?.setDirtyCanvas?.(true, true);
}

function installGroupMoveGuard() {
	const groupProto = globalThis.LGraphGroup?.prototype || globalThis.LiteGraph?.LGraphGroup?.prototype;
	if (!groupProto || groupProto.__gjjGroupDragGuardInstalled) return false;
	const originalMove = groupProto.move;
	if (typeof originalMove !== "function") return false;

	groupProto.__gjjGroupDragGuardInstalled = true;
	groupProto.move = function(deltax, deltay, ignore_nodes, ...rest) {
		const before = numberPair(this.pos);
		const snapshot = ignore_nodes ? [] : snapshotGroupNodes(this);
		setGroupMoving(true);
		const result = originalMove.apply(this, [deltax, deltay, ignore_nodes, ...rest]);
		const after = numberPair(this.pos);
		correctMovedNodes(snapshot, after[0] - before[0], after[1] - before[1]);
		scheduleClearMoving();
		return result;
	};
	return true;
}

function installPointerTracking() {
	if (globalThis.__gjjGroupDragGuardPointerInstalled) return;
	globalThis.__gjjGroupDragGuardPointerInstalled = true;
	document.addEventListener("pointerdown", markPointerDown, true);
	document.addEventListener("mousedown", markPointerDown, true);
	document.addEventListener("pointerup", markPointerUp, true);
	document.addEventListener("pointercancel", markPointerUp, true);
	document.addEventListener("mouseup", markPointerUp, true);
	window.addEventListener("blur", markPointerUp, true);
}

app.registerExtension({
	name: "GJJ.GroupDragGuard",
	setup() {
		installPointerTracking();
		if (!installGroupMoveGuard()) {
			setTimeout(installGroupMoveGuard, 500);
			setTimeout(installGroupMoveGuard, 1500);
		}
	},
});

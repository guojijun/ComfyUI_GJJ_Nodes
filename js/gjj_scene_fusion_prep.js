import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_SceneFusionPrep";
const PANEL_WIDGET = "gjj_scene_fusion_prep_panel";
const CONFIG_WIDGET = "placement_config";
const PERSON_PREFIX = "person_";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const MIN_PERSONS = 1;
const MAX_PERSONS = 12;
const HIDDEN_WIDGETS = new Set([CONFIG_WIDGET, "background_fit", "device", "process_res", "mask_blur"]);
const PY_WIDGET_ORDER = ["width", "height", CONFIG_WIDGET, "background_fit", "device", "process_res", "mask_blur"];
const DEFAULT_COLORS = ["#0000FF", "#FF0000", "#00FF00", "#FF00FF", "#00FFFF", "#FFFF00"];
const DEFAULT_POSE = {
	head: [0, -0.43],
	neck: [0, -0.25],
	pelvis: [0, 0.14],
	left_shoulder: [-0.15, -0.21],
	right_shoulder: [0.15, -0.21],
	left_elbow: [-0.22, 0.02],
	right_elbow: [0.22, 0.02],
	left_hand: [-0.18, 0.25],
	right_hand: [0.18, 0.25],
	left_knee: [-0.11, 0.42],
	right_knee: [0.11, 0.42],
	left_foot: [-0.13, 0.66],
	right_foot: [0.13, 0.66],
};
const FIGURE_ASPECT = 0.42;
const IK_CHAINS = [
	{ root: "left_shoulder", mid: "left_elbow", end: "left_hand", bend: 1 },
	{ root: "right_shoulder", mid: "right_elbow", end: "right_hand", bend: -1 },
	{ root: "pelvis", mid: "left_knee", end: "left_foot", bend: 1 },
	{ root: "pelvis", mid: "right_knee", end: "right_foot", bend: -1 },
];
const POSE_LINES = [
	["head", "neck"], ["neck", "pelvis"], ["left_shoulder", "right_shoulder"],
	["neck", "left_shoulder"], ["neck", "right_shoulder"],
	["left_shoulder", "left_elbow"], ["left_elbow", "left_hand"],
	["right_shoulder", "right_elbow"], ["right_elbow", "right_hand"],
	["pelvis", "left_knee"], ["left_knee", "left_foot"],
	["pelvis", "right_knee"], ["right_knee", "right_foot"],
];
const MERGED_UPPER_JOINT = "upper_body";
const HIDDEN_DRAW_JOINTS = new Set(["neck", "left_shoulder", "right_shoulder"]);

function injectStyles() {
	if (document.getElementById("gjj-scene-fusion-prep-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-scene-fusion-prep-style";
	style.textContent = `
.gjj-sfp-root{width:100%;box-sizing:border-box;color:#dce7e2;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;}
.gjj-sfp-buttons{display:flex;gap:6px;align-items:center;width:100%;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:2px 0 5px;}
.gjj-sfp-btn{height:27px;min-width:0;flex:1 1 0;border:1px solid #3f525a;border-radius:6px;background:#172229;color:#dce8ec;font:700 12px/25px system-ui,sans-serif;cursor:pointer;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sfp-btn:hover{background:#21313a;border-color:#55707a;}
.gjj-sfp-stage-wrap{width:100%;box-sizing:border-box;padding-top:4px;}
.gjj-sfp-stage{position:relative;width:100%;overflow:hidden;border:1px solid #33454d;border-radius:7px;background:#081015;box-sizing:border-box;touch-action:none;}
.gjj-sfp-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;}
.gjj-sfp-overlay{position:absolute;inset:0;width:100%;height:100%;overflow:visible;touch-action:none;}
.gjj-sfp-person{cursor:grab;}
.gjj-sfp-bone{fill:none;stroke-linecap:round;stroke-linejoin:round;}
.gjj-sfp-person-hit{fill:none;stroke:rgba(255,255,255,0);stroke-linecap:round;stroke-linejoin:round;pointer-events:stroke;cursor:grab;}
.gjj-sfp-head{fill:rgba(8,16,21,.2);}
.gjj-sfp-joint{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-joint-hit{fill:rgba(255,255,255,0);stroke:none;pointer-events:all;cursor:pointer;}
.gjj-sfp-handle{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-face-line{stroke-linecap:round;}
.gjj-sfp-face-handle{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-previews{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-top:7px;}
.gjj-sfp-preview{min-width:0;border:1px solid #2f424a;border-radius:7px;background:#10181d;padding:5px;box-sizing:border-box;}
.gjj-sfp-preview img{display:block;width:100%;height:98px;object-fit:contain;background:#071014;border-radius:5px;}
.gjj-sfp-preview span{display:block;padding-top:4px;color:#9fb1b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}
`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function findInput(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((item) => item?.name === name || String(item?.type || "") === `converted-widget:${name}`) : null;
}

function viewUrl(item) {
	if (!item?.filename) return "";
	if (item.__gjjSceneFusionCachedUrl) return item.__gjjSceneFusionCachedUrl;
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	item.__gjjSceneFusionCachedUrl = api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`);
	return item.__gjjSceneFusionCachedUrl;
}

function parsePayload(message) {
	const direct = Array.isArray(message?.gjj_scene_fusion_prep) ? message.gjj_scene_fusion_prep[0] : message?.gjj_scene_fusion_prep;
	if (direct?.canvas) return direct;
	const nested = Array.isArray(message?.ui?.gjj_scene_fusion_prep) ? message.ui.gjj_scene_fusion_prep[0] : message?.ui?.gjj_scene_fusion_prep;
	return nested?.canvas ? nested : null;
}

function finite(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function clamp(value, lower, upper) {
	return Math.max(lower, Math.min(upper, value));
}

function align16(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 1024;
	return Math.max(16, Math.floor(Math.max(16, Math.round(number)) / 16) * 16);
}

function personName(index) {
	return `${PERSON_PREFIX}${String(index).padStart(2, "0")}`;
}

function personIndex(name) {
	const match = String(name || "").match(/^person_(\d+)$/);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function personInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].filter((input) => String(input?.name || "").startsWith(PERSON_PREFIX)).sort((a, b) => personIndex(a.name) - personIndex(b.name))
		: [];
}

function hasLink(input) {
	return input?.link != null || (Array.isArray(input?.links) && input.links.length > 0);
}

function defaultPerson(index, count) {
	return {
		id: personName(index + 1),
		x: count <= 1 ? 0.5 : (index + 1) / (count + 1),
		y: 0.58,
		scale: 1,
		rotation: 0,
		face_angle: 0,
		color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
		z: index,
		pose: structuredClone(DEFAULT_POSE),
	};
}

function parseConfig(node) {
	try {
		const raw = widget(node, CONFIG_WIDGET)?.value || node?.properties?.[CONFIG_WIDGET] || "";
		const parsed = JSON.parse(String(raw || "{}"));
		return Array.isArray(parsed?.persons) ? parsed.persons : [];
	} catch (_) {
		return [];
	}
}

function writeConfig(node, persons) {
	const clean = persons.map((item, index) => ({
		id: String(item.id || personName(index + 1)),
		x: clamp(finite(item.x, 0.5), -1, 2),
		y: clamp(finite(item.y, 0.58), -1, 2),
		scale: clamp(finite(item.scale, 1), 0.08, 4),
		rotation: clamp(finite(item.rotation, 0), -180, 180),
		face_angle: clamp(finite(item.face_angle, 0), -180, 180),
		color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
		z: finite(item.z, index),
		pose: normalizePose(item.pose),
	}));
	const serialized = JSON.stringify({ version: 1, persons: clean });
	const item = widget(node, CONFIG_WIDGET);
	if (item) item.value = serialized;
	node.properties ||= {};
	node.properties[CONFIG_WIDGET] = serialized;
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function normalizePose(value) {
	const pose = structuredClone(DEFAULT_POSE);
	if (value && typeof value === "object") {
		for (const key of Object.keys(DEFAULT_POSE)) {
			const point = value[key];
			if (Array.isArray(point) && point.length >= 2) {
				pose[key] = [clamp(finite(point[0], pose[key][0]), -1.2, 1.2), clamp(finite(point[1], pose[key][1]), -1.2, 1.2)];
			}
		}
	}
	return pose;
}

function metricPoint(point) {
	return [finite(point?.[0], 0) * FIGURE_ASPECT, finite(point?.[1], 0)];
}

function localPoint(point) {
	return [clamp(finite(point?.[0], 0) / FIGURE_ASPECT, -1.2, 1.2), clamp(finite(point?.[1], 0), -1.2, 1.2)];
}

function metricToLocal(point) {
	return localPoint(point);
}

function distanceMetric(a, b) {
	const pa = metricPoint(a);
	const pb = metricPoint(b);
	return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
}

function boneLength(a, b) {
	return Math.max(0.01, distanceMetric(DEFAULT_POSE[a], DEFAULT_POSE[b]));
}

function translatePosePoints(clean, keys, delta) {
	for (const key of keys) {
		clean[key] = [
			clamp(finite(clean[key]?.[0], DEFAULT_POSE[key][0]) + delta[0], -1.2, 1.2),
			clamp(finite(clean[key]?.[1], DEFAULT_POSE[key][1]) + delta[1], -1.2, 1.2),
		];
	}
	return clean;
}

function fixedLengthPoint(anchorLocal, targetLocal, length, fallbackLocal) {
	const anchor = metricPoint(anchorLocal);
	const target = metricPoint(targetLocal);
	const fallback = metricPoint(fallbackLocal || targetLocal);
	let dx = target[0] - anchor[0];
	let dy = target[1] - anchor[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = fallback[0] - anchor[0];
		dy = fallback[1] - anchor[1];
		dist = Math.hypot(dx, dy) || 1;
	}
	return metricToLocal([anchor[0] + (dx / dist) * length, anchor[1] + (dy / dist) * length]);
}

function chainLengths(chain) {
	return {
		upper: Math.max(0.01, distanceMetric(DEFAULT_POSE[chain.root], DEFAULT_POSE[chain.mid])),
		lower: Math.max(0.01, distanceMetric(DEFAULT_POSE[chain.mid], DEFAULT_POSE[chain.end])),
	};
}

function sideOfLine(root, end, point, fallback = 1) {
	const a = metricPoint(root);
	const b = metricPoint(end);
	const p = metricPoint(point);
	const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
	return Math.abs(cross) < 1e-5 ? (fallback < 0 ? -1 : 1) : (cross < 0 ? -1 : 1);
}

function solveTwoBone(rootLocal, targetLocal, upperLen, lowerLen, bendSide = 1) {
	const root = metricPoint(rootLocal);
	let target = metricPoint(targetLocal);
	let dx = target[0] - root[0];
	let dy = target[1] - root[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = 0;
		dy = upperLen + lowerLen;
		dist = Math.hypot(dx, dy);
	}
	const minReach = Math.max(0.001, Math.abs(upperLen - lowerLen) + 0.001);
	const maxReach = Math.max(minReach, upperLen + lowerLen - 0.001);
	const solvedDist = clamp(dist, minReach, maxReach);
	const ux = dx / dist;
	const uy = dy / dist;
	target = [root[0] + ux * solvedDist, root[1] + uy * solvedDist];
	const along = clamp((upperLen * upperLen + solvedDist * solvedDist - lowerLen * lowerLen) / (2 * solvedDist), 0, upperLen);
	const height = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));
	const side = bendSide < 0 ? -1 : 1;
	const mid = [
		root[0] + ux * along + (-uy) * height * side,
		root[1] + uy * along + ux * height * side,
	];
	return { mid: localPoint(mid), end: localPoint(target) };
}

function moveUpperBodyJoint(clean, local) {
	const oldNeck = clean.neck || DEFAULT_POSE.neck;
	const newNeck = fixedLengthPoint(clean.pelvis, local, boneLength("neck", "pelvis"), oldNeck);
	const delta = [newNeck[0] - oldNeck[0], newNeck[1] - oldNeck[1]];
	return translatePosePoints(clean, ["head", "neck", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand"], delta);
}

function movePelvisJoint(clean, local) {
	const oldPelvis = clean.pelvis || DEFAULT_POSE.pelvis;
	const newPelvis = fixedLengthPoint(clean.neck, local, boneLength("neck", "pelvis"), oldPelvis);
	const delta = [newPelvis[0] - oldPelvis[0], newPelvis[1] - oldPelvis[1]];
	return translatePosePoints(clean, ["pelvis", "left_knee", "right_knee", "left_foot", "right_foot"], delta);
}

function applyFkMidDrag(clean, chain, local) {
	const lengths = chainLengths(chain);
	const root = metricPoint(clean[chain.root]);
	const target = metricPoint(local);
	const oldMid = metricPoint(clean[chain.mid]);
	const oldEnd = metricPoint(clean[chain.end]);
	let dx = target[0] - root[0];
	let dy = target[1] - root[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = oldMid[0] - root[0];
		dy = oldMid[1] - root[1];
		dist = Math.hypot(dx, dy) || 1;
	}
	const newMid = [root[0] + (dx / dist) * lengths.upper, root[1] + (dy / dist) * lengths.upper];
	const delta = [newMid[0] - oldMid[0], newMid[1] - oldMid[1]];
	clean[chain.mid] = metricToLocal(newMid);
	const movedEnd = metricToLocal([oldEnd[0] + delta[0], oldEnd[1] + delta[1]]);
	clean[chain.end] = fixedLengthPoint(clean[chain.mid], movedEnd, lengths.lower, clean[chain.end]);
	return clean;
}

function normalizeIkPose(pose, active = null) {
	const clean = structuredClone(pose || DEFAULT_POSE);
	for (const chain of IK_CHAINS) {
		const lengths = chainLengths(chain);
		const bend = sideOfLine(clean[chain.root], clean[chain.end], clean[chain.mid], chain.bend);
		const solved = solveTwoBone(clean[chain.root], clean[chain.end], lengths.upper, lengths.lower, bend);
		if (active?.key === chain.mid) {
			const midSide = sideOfLine(clean[chain.root], clean[chain.end], active.local, chain.bend);
			const midSolved = solveTwoBone(clean[chain.root], clean[chain.end], lengths.upper, lengths.lower, midSide);
			clean[chain.mid] = midSolved.mid;
			continue;
		}
		clean[chain.mid] = solved.mid;
		clean[chain.end] = solved.end;
	}
	return clean;
}

function applyJointDrag(pose, key, local) {
	const clean = normalizePose(pose);
	if (key === MERGED_UPPER_JOINT) {
		return moveUpperBodyJoint(clean, local);
	}
	const chain = IK_CHAINS.find((item) => item.mid === key || item.end === key);
	if (!chain) {
		if (key === "pelvis") {
			return movePelvisJoint(clean, local);
		}
		if (key === "head") {
			clean.head = fixedLengthPoint(clean.neck, local, boneLength("head", "neck"), clean.head);
			return clean;
		}
		clean[key] = local;
		return clean;
	}
	if (key === chain.mid) {
		return applyFkMidDrag(clean, chain, local);
	}
	const lengths = chainLengths(chain);
	const bend = sideOfLine(clean[chain.root], local, clean[chain.mid], chain.bend);
	const solved = solveTwoBone(clean[chain.root], local, lengths.upper, lengths.lower, bend);
	clean[chain.mid] = solved.mid;
	clean[chain.end] = solved.end;
	return clean;
}

function validColor(value, fallback) {
	const text = String(value || "");
	return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : fallback;
}

function configFromPayload(node) {
	const payload = node.__gjjSceneFusionPayload;
	const persons = Array.isArray(payload?.persons) ? payload.persons : [];
	const saved = parseConfig(node);
	const byId = new Map(saved.map((item) => [String(item?.id || ""), item]));
	return persons.map((person, index) => {
		const id = String(person?.id || personName(index + 1));
		const savedPerson = byId.get(id) || {};
		return {
			...defaultPerson(index, persons.length),
			...person,
			...savedPerson,
			id,
			color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
			face_angle: finite(savedPerson.face_angle ?? person?.face_angle, 0),
			pose: normalizePose((savedPerson || person)?.pose),
		};
	});
}

function personRect(person, canvasW, canvasH) {
	const figureH = Math.max(24, Math.round(canvasH * 0.56 * clamp(finite(person.scale, 1), 0.08, 4)));
	const figureW = Math.max(16, Math.round(figureH * 0.42));
	const cx = Math.round(finite(person.x, 0.5) * canvasW);
	const cy = Math.round(finite(person.y, 0.58) * canvasH);
	return { left: cx - figureW / 2, top: cy - figureH / 2, width: figureW, height: figureH, cx, cy };
}

function localToCanvas(local, rect, degrees) {
	const x = rect.cx + finite(local?.[0], 0) * rect.width;
	const y = rect.cy + finite(local?.[1], 0) * rect.height;
	const rad = (degrees || 0) * Math.PI / 180;
	const dx = x - rect.cx;
	const dy = y - rect.cy;
	return [rect.cx + dx * Math.cos(rad) - dy * Math.sin(rad), rect.cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
}

function canvasToLocal(x, y, rect, degrees) {
	const rad = -(degrees || 0) * Math.PI / 180;
	const dx = x - rect.cx;
	const dy = y - rect.cy;
	const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
	const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
	return [clamp(rx / Math.max(1, rect.width), -1.2, 1.2), clamp(ry / Math.max(1, rect.height), -1.2, 1.2)];
}

function makeSvg(tag) {
	return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function renderPayload(node) {
	const payload = node.__gjjSceneFusionPayload;
	if (!payload?.canvas || !Array.isArray(payload.persons)) return;
	const ui = ensurePreview(node);
	if (!ui) return;
	const canvasW = Math.max(1, Number(payload.canvas.width || 1));
	const canvasH = Math.max(1, Number(payload.canvas.height || 1));
	ui.stage.style.aspectRatio = `${Math.round(canvasW)} / ${Math.round(canvasH)}`;
	ui.stage.replaceChildren();
	const bg = document.createElement("img");
	bg.className = "gjj-sfp-bg";
	bg.src = viewUrl(payload.background);
	ui.stage.appendChild(bg);
	const svg = makeSvg("svg");
	svg.classList.add("gjj-sfp-overlay");
	svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);
	ui.stage.appendChild(svg);

	const persons = configFromPayload(node);
	if (!node.__gjjSceneFusionSelected || !persons.some((p) => p.id === node.__gjjSceneFusionSelected)) {
		node.__gjjSceneFusionSelected = persons[0]?.id || "";
	}
	for (const person of [...persons].sort((a, b) => finite(a.z, 0) - finite(b.z, 0))) {
		drawPerson(node, svg, person, persons, canvasW, canvasH);
	}
	renderOutputPreviews(ui, payload);
	refreshSize(node);
}

function drawPerson(node, svg, person, persons, canvasW, canvasH) {
	const rect = personRect(person, canvasW, canvasH);
	const color = validColor(person.color, "#0000FF");
	const selected = node.__gjjSceneFusionSelected === person.id;
	const group = makeSvg("g");
	group.classList.add("gjj-sfp-person");
	if (selected) group.classList.add("selected");
	group.dataset.personId = person.id;
	const points = {};
	for (const key of Object.keys(DEFAULT_POSE)) points[key] = localToCanvas(person.pose?.[key] || DEFAULT_POSE[key], rect, finite(person.rotation, 0));
	const head = points.head;
	const radius = Math.max(10, Math.round(rect.height * 0.105));
	const faceAngle = finite(person.rotation, 0) + finite(person.face_angle, 0);
	const faceCenter = pointFromAngle(head, radius * 0.34, faceAngle);
	for (const [a, b] of POSE_LINES) {
		let start = points[a];
		let end = points[b];
		if (a === "head" || b === "head") {
			[start, end] = trimLineToCircle(start, end, faceCenter, radius * 0.96);
		}
		const line = makeSvg("line");
		line.classList.add("gjj-sfp-bone");
		line.setAttribute("x1", start[0]);
		line.setAttribute("y1", start[1]);
		line.setAttribute("x2", end[0]);
		line.setAttribute("y2", end[1]);
		line.setAttribute("stroke", color);
		line.setAttribute("stroke-width", Math.max(3, Math.round(rect.height * 0.018)));
		group.appendChild(line);
		const hitLine = makeSvg("line");
		hitLine.classList.add("gjj-sfp-person-hit");
		hitLine.setAttribute("x1", start[0]);
		hitLine.setAttribute("y1", start[1]);
		hitLine.setAttribute("x2", end[0]);
		hitLine.setAttribute("y2", end[1]);
		hitLine.setAttribute("stroke-width", Math.max(22, Math.round(rect.height * 0.075)));
		group.appendChild(hitLine);
	}
	const circle = makeSvg("circle");
	circle.classList.add("gjj-sfp-head");
	circle.setAttribute("cx", head[0]);
	circle.setAttribute("cy", head[1]);
	circle.setAttribute("r", radius);
	circle.setAttribute("stroke", color);
	circle.setAttribute("stroke-width", Math.max(3, Math.round(rect.height * 0.018)));
	group.appendChild(circle);
	const headHit = makeSvg("circle");
	headHit.classList.add("gjj-sfp-person-hit");
	headHit.setAttribute("cx", head[0]);
	headHit.setAttribute("cy", head[1]);
	headHit.setAttribute("r", Math.max(radius + 10, Math.round(rect.height * 0.16)));
	group.appendChild(headHit);
	const faceH1 = pointFromAngle(faceCenter, radius * 0.82, faceAngle);
	const faceH2 = pointFromAngle(faceCenter, radius * 0.82, faceAngle + 180);
	const faceV1 = pointFromAngle(faceCenter, radius * 0.82, faceAngle + 90);
	const faceV2 = pointFromAngle(faceCenter, radius * 0.82, faceAngle - 90);
	for (const [x1, y1, x2, y2] of [[faceH1[0], faceH1[1], faceH2[0], faceH2[1]], [faceV1[0], faceV1[1], faceV2[0], faceV2[1]]]) {
		const line = makeSvg("line");
		line.classList.add("gjj-sfp-face-line");
		line.setAttribute("x1", x1);
		line.setAttribute("y1", y1);
		line.setAttribute("x2", x2);
		line.setAttribute("y2", y2);
		line.setAttribute("stroke", color);
		line.setAttribute("stroke-width", Math.max(1, Math.round(rect.height * 0.008)));
		group.appendChild(line);
	}
	const jointEntries = Object.entries(points).filter(([key]) => !HIDDEN_DRAW_JOINTS.has(key));
	jointEntries.push([MERGED_UPPER_JOINT, points.neck]);
	for (const [key, point] of jointEntries) {
		const joint = makeSvg("circle");
		joint.classList.add("gjj-sfp-joint");
		joint.dataset.joint = key;
		joint.setAttribute("cx", point[0]);
		joint.setAttribute("cy", point[1]);
		joint.setAttribute("r", selected ? "8.5" : "6.5");
		joint.setAttribute("fill", color);
		bindJointDrag(node, joint, person, persons, canvasW, canvasH);
		group.appendChild(joint);
		const jointHit = makeSvg("circle");
		jointHit.classList.add("gjj-sfp-joint-hit");
		jointHit.dataset.joint = key;
		jointHit.setAttribute("cx", point[0]);
		jointHit.setAttribute("cy", point[1]);
		jointHit.setAttribute("r", selected ? "17" : "14");
		bindJointDrag(node, jointHit, person, persons, canvasW, canvasH);
		group.appendChild(jointHit);
	}
	if (selected) {
		drawControlHandles(node, group, person, persons, rect, head, radius, color, canvasW, canvasH);
	}
	bindPersonDrag(node, group, person, persons, canvasW, canvasH);
	svg.appendChild(group);
}

function pointFromAngle(center, length, degrees) {
	const rad = (degrees || 0) * Math.PI / 180;
	return [center[0] + Math.cos(rad) * length, center[1] + Math.sin(rad) * length];
}

function trimLineToCircle(start, end, center, radius) {
	const dx = end[0] - start[0];
	const dy = end[1] - start[1];
	const fx = start[0] - center[0];
	const fy = start[1] - center[1];
	const a = dx * dx + dy * dy;
	if (a <= 1e-6) return [start, end];
	const b = 2 * (fx * dx + fy * dy);
	const c = fx * fx + fy * fy - radius * radius;
	const disc = b * b - 4 * a * c;
	if (disc < 0) return [start, end];
	const root = Math.sqrt(disc);
	const ts = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((t) => t >= 0 && t <= 1);
	if (!ts.length) return [start, end];
	const startInside = ((start[0] - center[0]) ** 2 + (start[1] - center[1]) ** 2) < radius * radius;
	const t = startInside ? Math.max(...ts) : Math.min(...ts);
	const point = [start[0] + dx * t, start[1] + dy * t];
	return startInside ? [point, end] : [start, point];
}

function drawControlHandles(node, group, person, persons, rect, head, radius, color, canvasW, canvasH) {
	const pelvis = localToCanvas(person.pose?.pelvis || DEFAULT_POSE.pelvis, rect, finite(person.rotation, 0));
	const move = pelvis;
	const rotate = pointFromAngle([rect.cx, rect.cy], Math.max(24, rect.height * 0.62), finite(person.rotation, 0) - 90);
	const scale = localToCanvas([0.28, 0.66], rect, finite(person.rotation, 0));
	const faceAngle = finite(person.rotation, 0) + finite(person.face_angle, 0);
	const faceCenter = pointFromAngle(head, radius * 0.34, faceAngle);
	const face = pointFromAngle(faceCenter, radius * 1.65, faceAngle);
	for (const [kind, point, size] of [["move", move, 13], ["rotate", rotate, 13], ["scale", scale, 13]]) {
		const handle = makeControlHandle(kind, point, size, color);
		bindHandleDrag(node, handle, person, persons, canvasW, canvasH);
		group.appendChild(handle);
	}
	const faceGuide = makeSvg("line");
	faceGuide.setAttribute("x1", faceCenter[0]);
	faceGuide.setAttribute("y1", faceCenter[1]);
	faceGuide.setAttribute("x2", face[0]);
	faceGuide.setAttribute("y2", face[1]);
	faceGuide.setAttribute("stroke", color);
	faceGuide.setAttribute("stroke-width", "1.5");
	faceGuide.setAttribute("stroke-dasharray", "4 4");
	group.appendChild(faceGuide);
	const faceHandle = makeControlHandle("face", face, 12, color);
	bindHandleDrag(node, faceHandle, person, persons, canvasW, canvasH);
	group.appendChild(faceHandle);
}

function makeControlHandle(kind, point, size, color) {
	const handle = makeSvg("g");
	handle.classList.add(kind === "face" ? "gjj-sfp-face-handle" : "gjj-sfp-handle");
	handle.dataset.handle = kind;
	handle.style.pointerEvents = "all";
	const x = Number(point[0]);
	const y = Number(point[1]);
	const fill = kind === "move" || kind === "face" ? "#FFFFFF" : color;
	let shape = null;
	if (kind === "move") {
		shape = makeSvg("polygon");
		shape.setAttribute("points", `${x},${y - size} ${x + size},${y} ${x},${y + size} ${x - size},${y}`);
	} else if (kind === "rotate") {
		shape = makeSvg("polygon");
		shape.setAttribute("points", `${x},${y - size} ${x + size * 0.9},${y + size * 0.65} ${x - size * 0.9},${y + size * 0.65}`);
	} else if (kind === "scale") {
		shape = makeSvg("rect");
		shape.setAttribute("x", x - size * 0.82);
		shape.setAttribute("y", y - size * 0.82);
		shape.setAttribute("width", size * 1.64);
		shape.setAttribute("height", size * 1.64);
		shape.setAttribute("rx", "2");
	} else {
		shape = makeSvg("circle");
		shape.setAttribute("cx", x);
		shape.setAttribute("cy", y);
		shape.setAttribute("r", size);
	}
	shape.setAttribute("fill", fill);
	shape.setAttribute("stroke", "#071014");
	shape.setAttribute("stroke-width", "2");
	shape.style.pointerEvents = "all";
	handle.appendChild(shape);

	const icon = makeSvg("text");
	icon.setAttribute("x", x);
	icon.setAttribute("y", y + size * 0.32);
	icon.setAttribute("text-anchor", "middle");
	icon.setAttribute("font-size", Math.max(10, size * 1.05));
	icon.setAttribute("font-weight", "800");
	icon.setAttribute("fill", kind === "move" || kind === "face" ? "#102026" : "#FFFFFF");
	icon.style.pointerEvents = "none";
	icon.textContent = kind === "move" ? "✥" : kind === "rotate" ? "↻" : kind === "scale" ? "□" : "👁";
	handle.appendChild(icon);
	return handle;
}

function svgPoint(event, svg, canvasW, canvasH) {
	const rect = svg.getBoundingClientRect();
	return svgPointFromRect(event, rect, canvasW, canvasH);
}

function svgPointFromRect(event, rect, canvasW, canvasH) {
	return [
		((event.clientX - rect.left) / Math.max(1, rect.width)) * canvasW,
		((event.clientY - rect.top) / Math.max(1, rect.height)) * canvasH,
	];
}

function bindPersonDrag(node, group, person, persons, canvasW, canvasH) {
	group.addEventListener("pointerdown", (event) => {
		if (event.target?.classList?.contains("gjj-sfp-joint") || event.target?.classList?.contains("gjj-sfp-joint-hit")) return;
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const svg = group.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const start = svgPointFromRect(event, svgRect, canvasW, canvasH);
		const origin = [finite(person.x, 0.5), finite(person.y, 0.58)];
		const maxZ = Math.max(0, ...persons.map((item) => finite(item.z, 0)));
		person.z = maxZ + 1;
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const now = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			person.x = clamp(origin[0] + (now[0] - start[0]) / canvasW, -1, 2);
			person.y = clamp(origin[1] + (now[1] - start[1]) / canvasH, -1, 2);
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
		writeConfig(node, persons);
		renderPayload(node);
	});
}

function bindJointDrag(node, joint, person, persons, canvasW, canvasH) {
	joint.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const key = joint.dataset.joint;
		const svg = joint.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const [x, y] = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			const rect = personRect(person, canvasW, canvasH);
			person.pose ||= structuredClone(DEFAULT_POSE);
			const local = canvasToLocal(x, y, rect, finite(person.rotation, 0));
			person.pose = applyJointDrag(person.pose, key, local);
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function bindHandleDrag(node, handle, person, persons, canvasW, canvasH) {
	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const kind = handle.dataset.handle;
		const svg = handle.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const start = svgPointFromRect(event, svgRect, canvasW, canvasH);
		const origin = {
			x: finite(person.x, 0.5),
			y: finite(person.y, 0.58),
			scale: finite(person.scale, 1),
			rotation: finite(person.rotation, 0),
			face_angle: finite(person.face_angle, 0),
		};
		const startRect = personRect(person, canvasW, canvasH);
		const startDist = Math.hypot(start[0] - startRect.cx, start[1] - startRect.cy) || 1;
		const startAngle = Math.atan2(start[1] - startRect.cy, start[0] - startRect.cx) * 180 / Math.PI;
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const now = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			if (kind === "move") {
				person.x = clamp(origin.x + (now[0] - start[0]) / canvasW, -1, 2);
				person.y = clamp(origin.y + (now[1] - start[1]) / canvasH, -1, 2);
			} else if (kind === "scale") {
				const distance = Math.hypot(now[0] - startRect.cx, now[1] - startRect.cy) || 1;
				person.scale = clamp(origin.scale * (distance / startDist), 0.08, 4);
			} else if (kind === "rotate") {
				const angle = Math.atan2(now[1] - startRect.cy, now[0] - startRect.cx) * 180 / Math.PI;
				person.rotation = clamp(origin.rotation + angle - startAngle, -180, 180);
			} else if (kind === "face") {
				const rect = personRect(person, canvasW, canvasH);
				const head = localToCanvas(person.pose?.head || DEFAULT_POSE.head, rect, finite(person.rotation, 0));
				const angle = Math.atan2(now[1] - head[1], now[0] - head[0]) * 180 / Math.PI;
				person.face_angle = clamp(angle - finite(person.rotation, 0), -180, 180);
			}
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function renderOutputPreviews(ui, payload) {
	if (!ui?.previews) return;
	ui.previews.replaceChildren();
	for (const [item, label] of [[payload.stick, "背景火柴棍"], [payload.white, "白底人物框"]]) {
		if (!item?.filename) continue;
		const card = document.createElement("div");
		card.className = "gjj-sfp-preview";
		const image = document.createElement("img");
		image.src = viewUrl(item);
		const text = document.createElement("span");
		text.textContent = label;
		card.append(image, text);
		ui.previews.appendChild(card);
	}
}

function ensurePreview(node) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.root) return null;
	if (!ui.stageWrap) {
		const stageWrap = document.createElement("div");
		stageWrap.className = "gjj-sfp-stage-wrap";
		const stage = document.createElement("div");
		stage.className = "gjj-sfp-stage";
		const previews = document.createElement("div");
		previews.className = "gjj-sfp-previews";
		stageWrap.append(stage, previews);
		ui.root.appendChild(stageWrap);
		ui.stageWrap = stageWrap;
		ui.stage = stage;
		ui.previews = previews;
	}
	return ui;
}

async function runCurrentNode(node, button = null) {
	const oldText = button?.textContent;
	if (button) {
		button.disabled = true;
		button.textContent = "刷新中";
	}
	try {
		return await queueOnlyCurrentNode(node);
	} catch (error) {
		console.warn("[GJJ] 人景融合准备刷新失败：", error);
		return false;
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText || "🔄 刷新";
		}
	}
}

function resetPersons(node) {
	const payload = node.__gjjSceneFusionPayload;
	const count = Array.isArray(payload?.persons) ? payload.persons.length : personInputs(node).filter(hasLink).length;
	const persons = Array.from({ length: Math.max(1, count) }, (_, index) => defaultPerson(index, Math.max(1, count)));
	writeConfig(node, persons);
	renderPayload(node);
}

function makeButton(label, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || label;
	button.className = "gjj-sfp-btn";
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	return button;
}

function makePanel(node) {
	const root = document.createElement("div");
	root.className = "gjj-sfp-root";
	root.addEventListener("pointerdown", (event) => event.stopPropagation());
	root.addEventListener("mousedown", (event) => event.stopPropagation());
	const buttons = document.createElement("div");
	buttons.className = "gjj-sfp-buttons";
	const refresh = makeButton("🔄 刷新", "重新执行当前节点，更新抠图和预览。");
	refresh.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await runCurrentNode(node, refresh);
	});
	const reset = makeButton("↺ 重置", "重置人物位置、颜色和火柴棍姿势。");
	reset.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetPersons(node);
	});
	buttons.append(refresh, reset);
	root.appendChild(buttons);
	node.__gjjSceneFusionUI = { root, buttons, refresh, reset, stageWrap: null, stage: null, controls: null, previews: null };
	return root;
}

function refreshSize(node) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.root) return;
	const height = Math.max(44, Math.ceil(ui.root.scrollHeight || ui.root.offsetHeight || 44) + 8);
	const width = Math.round(Number(node.size?.[0] || 360));
	node.__gjjSceneFusionHeight = height;
	node.setSize?.([width, height]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function setInputMeta(input, name, label, type, tooltip) {
	if (!input) return;
	input.name = name;
	input.label = label;
	input.localized_name = label;
	input.type = type;
	input.tooltip = tooltip;
}

function ensureInput(node, name, type) {
	let input = findInput(node, name);
	if (!input) {
		node.addInput?.(name, type);
		input = findInput(node, name);
	}
	return input;
}

function addPersonInput(node) {
	const inputs = personInputs(node);
	const next = inputs.length ? personIndex(inputs[inputs.length - 1].name) + 1 : 1;
	if (next <= MAX_PERSONS) node.addInput?.(personName(next), MEDIA_TYPE);
}

function trimTrailingPersons(node) {
	const inputs = personInputs(node);
	for (let index = inputs.length - 1; index >= MIN_PERSONS; index -= 1) {
		if (hasLink(inputs[index])) break;
		const slotIndex = node.inputs.indexOf(inputs[index]);
		if (slotIndex >= 0) node.removeInput?.(slotIndex);
	}
}

function ensureTrailingPerson(node) {
	const inputs = personInputs(node);
	if (!inputs.length) {
		addPersonInput(node);
		return;
	}
	if (hasLink(inputs[inputs.length - 1]) && inputs.length < MAX_PERSONS) addPersonInput(node);
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const ordered = [];
	const used = new Set();
	const push = (input) => {
		if (input && !used.has(input)) {
			ordered.push(input);
			used.add(input);
		}
	};
	push(findInput(node, "background"));
	for (const input of personInputs(node)) push(input);
	push(findInput(node, "width"));
	push(findInput(node, "height"));
	for (const input of node.inputs) push(input);
	node.inputs.splice(0, node.inputs.length, ...ordered);
}

function normalizeInputs(node) {
	ensureInput(node, "background", MEDIA_TYPE);
	ensureInput(node, "person_01", MEDIA_TYPE);
	trimTrailingPersons(node);
	ensureTrailingPerson(node);
	reorderInputs(node);
	setInputMeta(findInput(node, "background"), "background", "背景图", MEDIA_TYPE, "最终场景背景图。");
	for (const [index, input] of personInputs(node).entries()) {
		const number = index + 1;
		setInputMeta(input, personName(number), `人物 ${number}`, MEDIA_TYPE, "连接人物图片；最后一个人物口连接后会自动扩展下一口。");
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function normalizeOutputs(node) {
	if (!Array.isArray(node?.outputs)) return;
	while (node.outputs.length > 2) node.removeOutput?.(node.outputs.length - 1);
	if (!node.outputs[0]) node.addOutput?.("背景火柴棍标注图", "IMAGE");
	if (!node.outputs[1]) node.addOutput?.("白底人物色框图", "IMAGE");
	node.outputs[0].name = "背景火柴棍标注图";
	node.outputs[0].label = "背景火柴棍标注图";
	node.outputs[0].localized_name = "背景火柴棍标注图";
	node.outputs[0].type = "IMAGE";
	node.outputs[1].name = "白底人物色框图";
	node.outputs[1].label = "白底人物色框图";
	node.outputs[1].localized_name = "白底人物色框图";
	node.outputs[1].type = "IMAGE";
}

function validParamValue(name, value) {
	if (name === "width" || name === "height") {
		return align16(value);
	}
	if (name === CONFIG_WIDGET) {
		const text = String(value ?? "");
		try {
			if (text) JSON.parse(text);
			return text;
		} catch (_) {
			return "";
		}
	}
	if (name === "background_fit") return ["裁切填满", "等比留边", "拉伸填满"].includes(value) ? value : "裁切填满";
	if (name === "device") return ["自动", "GPU", "CPU"].includes(value) ? value : "自动";
	if (name === "process_res") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 64 && number <= 4096 ? Math.round(number) : 1024;
	}
	if (name === "mask_blur") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 && number <= 32 ? number : 0.8;
	}
	return value ?? "";
}

function canonicalValues(properties = {}) {
	return PY_WIDGET_ORDER.map((name) => validParamValue(name, properties?.[name]));
}

function restoreProperties(node) {
	node.properties ||= {};
	for (const name of PY_WIDGET_ORDER) {
		const item = widget(node, name);
		const value = validParamValue(name, node.properties[name] ?? item?.value);
		node.properties[name] = value;
		if (item) item.value = value;
	}
}

function prepareSerialized(serializedNode) {
	if (!serializedNode) return;
	serializedNode.properties ||= {};
	const raw = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
	for (let index = 0; index < PY_WIDGET_ORDER.length; index++) {
		const name = PY_WIDGET_ORDER[index];
		serializedNode.properties[name] = validParamValue(name, serializedNode.properties[name] ?? raw[index]);
	}
	serializedNode.widgets_values = canonicalValues(serializedNode.properties);
}

function mountPanel(node) {
	injectStyles();
	if (!node.__gjjSceneFusionPanelWidget) {
		const root = makePanel(node);
		const panel = node.addDOMWidget?.(PANEL_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => node.__gjjSceneFusionHeight || Math.max(44, root.scrollHeight || root.offsetHeight || 44),
		});
		if (panel) {
			panel.serialize = false;
			panel.options ||= {};
			panel.options.serialize = false;
			panel.value = undefined;
			panel.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 360)), node.__gjjSceneFusionHeight || Math.max(44, root.scrollHeight || root.offsetHeight || 44)];
		}
		node.__gjjSceneFusionPanelWidget = panel || { element: root };
	}
	refreshSize(node);
}

function stabilize(node) {
	if (!node) return;
	restoreProperties(node);
	hideWidgets(node);
	normalizeInputs(node);
	normalizeOutputs(node);
	mountPanel(node);
	if (node.__gjjSceneFusionPayload) renderPayload(node);
	refreshSize(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjSceneFusionTimer);
	node.__gjjSceneFusionTimer = setTimeout(() => stabilize(node), ms);
}

function scheduleRefresh(node) {
	clearTimeout(node.__gjjSceneFusionRefreshTimer);
	node.__gjjSceneFusionRefreshTimer = setTimeout(() => {
		if (hasLink(findInput(node, "background")) && personInputs(node).some(hasLink)) runCurrentNode(node);
	}, 280);
}

app.registerExtension({
	name: "GJJ.SceneFusionPrep",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			prepareSerialized(serializedNode);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			this.properties ||= {};
			Object.assign(this.properties, serializedNode?.properties || {});
			restoreProperties(this);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalSerialize?.apply(this, [serializedNode]);
			this.properties ||= {};
			for (const name of PY_WIDGET_ORDER) {
				const item = widget(this, name);
				if (item) this.properties[name] = validParamValue(name, item.value);
			}
			if (serializedNode) {
				serializedNode.properties ||= {};
				Object.assign(serializedNode.properties, this.properties);
				serializedNode.widgets_values = canonicalValues(this.properties);
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			scheduleRefresh(this);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			const payload = parsePayload(message);
			if (payload) {
				this.__gjjSceneFusionPayload = payload;
				if (payload.placement_config) writeConfig(this, payload.placement_config.persons || []);
				renderPayload(this);
			}
			setTimeout(() => stabilize(this), 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === NODE_TYPE) setTimeout(() => stabilize(node), 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) stabilize(node);
		}
	},
});

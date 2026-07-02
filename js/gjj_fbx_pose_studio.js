import { app } from "/scripts/app.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_CLASS = "GJJ_FBXPoseStudio";
const ROUTE_BASE = "/gjj/fbx_pose_studio";
const HIDDEN_WIDGETS = new Set(["fbx_path", "width", "height", "image_data", "pose_json"]);
const DEG = Math.PI / 180;
const INTERACTION_MODES = Object.freeze({
	view: "view",
	ik: "ik",
	rotate: "rotate",
});

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name) || null;
}

function setWidget(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	try { item.callback?.(value); } catch (_) {}
}

function getWidget(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function hideWidget(item) {
	if (!item || item.__gjjFbxHidden) return;
	item.__gjjFbxHidden = true;
	item.hidden = true;
	item.type = `converted-widget:${item.name || "hidden"}`;
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
	item.options ||= {};
	if (item.element) item.element.style.display = "none";
	if (item.inputEl) item.inputEl.style.display = "none";
}

function m4Identity() {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function m4Mul(a, b) {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			out[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
		}
	}
	return out;
}

function m4Translate(x, y, z) {
	const m = m4Identity();
	m[12] = x; m[13] = y; m[14] = z;
	return m;
}

function m4Scale(x, y, z) {
	const m = m4Identity();
	m[0] = x; m[5] = y; m[10] = z;
	return m;
}

function m4RotX(rad) {
	const c = Math.cos(rad), s = Math.sin(rad);
	return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

function m4RotY(rad) {
	const c = Math.cos(rad), s = Math.sin(rad);
	return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function m4RotZ(rad) {
	const c = Math.cos(rad), s = Math.sin(rad);
	return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function m4TRS(t, r, s, extraRot = [0, 0, 0]) {
	const rx = (Number(r?.[0] || 0) + Number(extraRot?.[0] || 0)) * DEG;
	const ry = (Number(r?.[1] || 0) + Number(extraRot?.[1] || 0)) * DEG;
	const rz = (Number(r?.[2] || 0) + Number(extraRot?.[2] || 0)) * DEG;
	return m4Mul(m4Translate(t?.[0] || 0, t?.[1] || 0, t?.[2] || 0), m4Mul(m4RotZ(rz), m4Mul(m4RotY(ry), m4Mul(m4RotX(rx), m4Scale(s?.[0] || 1, s?.[1] || 1, s?.[2] || 1)))));
}

function m4Invert(a) {
	const out = [];
	const b00 = a[0] * a[5] - a[1] * a[4];
	const b01 = a[0] * a[6] - a[2] * a[4];
	const b02 = a[0] * a[7] - a[3] * a[4];
	const b03 = a[1] * a[6] - a[2] * a[5];
	const b04 = a[1] * a[7] - a[3] * a[5];
	const b05 = a[2] * a[7] - a[3] * a[6];
	const b06 = a[8] * a[13] - a[9] * a[12];
	const b07 = a[8] * a[14] - a[10] * a[12];
	const b08 = a[8] * a[15] - a[11] * a[12];
	const b09 = a[9] * a[14] - a[10] * a[13];
	const b10 = a[9] * a[15] - a[11] * a[13];
	const b11 = a[10] * a[15] - a[11] * a[14];
	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return m4Identity();
	det = 1.0 / det;
	out[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
	out[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
	out[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
	out[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
	out[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
	out[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
	out[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
	out[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
	out[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
	out[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
	out[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
	out[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
	out[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
	out[13] = (a[8] * b03 - a[0] * b07 + a[2] * b06) * det;
	out[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
	out[15] = (a[0] * b09 - a[1] * b07 + a[4] * b01) * det;
	return out;
}

function m4Transform(m, x, y, z) {
	return [
		m[0] * x + m[4] * y + m[8] * z + m[12],
		m[1] * x + m[5] * y + m[9] * z + m[13],
		m[2] * x + m[6] * y + m[10] * z + m[14],
	];
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function v3Add(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function v3Scale(v, s) {
	return [v[0] * s, v[1] * s, v[2] * s];
}

function v3Normalize(v) {
	const length = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / length, v[1] / length, v[2] / length];
}

function v3Cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function projectPoint(m, point, width, height) {
	const x = point[0], y = point[1], z = point[2];
	const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
	const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
	const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
	const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (Math.abs(cw) < 0.00001) return null;
	return {
		x: (cx / cw * 0.5 + 0.5) * width,
		y: (1 - (cy / cw * 0.5 + 0.5)) * height,
		z: cz / cw,
	};
}

function viewportLocalPoint(element, clientX, clientY) {
	const rect = element.getBoundingClientRect();
	const width = element.clientWidth || rect.width || 1;
	const height = element.clientHeight || rect.height || 1;
	const sx = width / (rect.width || width || 1);
	const sy = height / (rect.height || height || 1);
	return {
		x: (clientX - rect.left) * sx,
		y: (clientY - rect.top) * sy,
		width,
		height,
	};
}

function isPrimaryControlBoneName(name) {
	const text = String(name || "").replace(/^mixamorig:/, "").toLowerCase();
	if (!text) return false;
	if (text.includes("eye") || text.includes("_end") || text.endsWith("end")) return false;
	if (text.includes("thumb") || text.includes("index") || text.includes("middle") || text.includes("ring") || text.includes("pinky")) return false;
	return [
		"hips",
		"spine2",
		"head",
		"leftarm",
		"leftforearm",
		"lefthand",
		"rightarm",
		"rightforearm",
		"righthand",
		"leftupleg",
		"leftleg",
		"leftfoot",
		"lefttoebase",
		"rightupleg",
		"rightleg",
		"rightfoot",
		"righttoebase",
	].includes(text);
}

function perspective(fovy, aspect, near, far) {
	const f = 1 / Math.tan(fovy / 2);
	const nf = 1 / (near - far);
	return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, target, up) {
	const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
	let zl = Math.hypot(zx, zy, zz) || 1;
	const z = [zx / zl, zy / zl, zz / zl];
	let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
	let xl = Math.hypot(x[0], x[1], x[2]) || 1;
	x = [x[0] / xl, x[1] / xl, x[2] / xl];
	const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
	return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1];
}

function makeShader(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
	return shader;
}

function makeProgram(gl) {
	const vs = makeShader(gl, gl.VERTEX_SHADER, `
		attribute vec3 a_position;
		attribute vec3 a_normal;
		uniform mat4 u_mvp;
		uniform mat4 u_model;
		varying vec3 v_normal;
		void main() {
			v_normal = mat3(u_model) * a_normal;
			gl_Position = u_mvp * vec4(a_position, 1.0);
		}
	`);
	const fs = makeShader(gl, gl.FRAGMENT_SHADER, `
		precision mediump float;
		varying vec3 v_normal;
		uniform vec3 u_color;
		void main() {
			vec3 n = normalize(v_normal);
			float key = max(dot(n, normalize(vec3(0.35, 0.8, 0.55))), 0.0);
			float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.0) * 0.18;
			vec3 color = u_color * (0.28 + key * 0.72) + vec3(0.55, 0.75, 0.9) * rim;
			gl_FragColor = vec4(color, 1.0);
		}
	`);
	const program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
	return program;
}

class FbxRenderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.gl = canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
		if (!this.gl) {
			throw new Error("浏览器没有启用 WebGL，无法显示 3D 预览。");
		}
		this.program = makeProgram(this.gl);
		this.meshes = [];
		this.bones = [];
		this.baseGlobals = [];
		this.joints = [];
		this.controlCenters = [];
		this.jointMeshCenters = [];
		this.boneBoundaryCenters = [];
		this.pivotCenters = [];
		this.primaryBoneIndices = [];
		this.subtreeSets = [];
		this.boneDepths = [];
		this.pose = {};
		this.ikOffsets = {};
		this.selectedBone = 0;
		this.activeControlBone = null;
		this.poseEditingEnabled = true;
		this.interactionMode = INTERACTION_MODES.view;
		this.camera = { yaw: 25, pitch: 12, distance: 3.4, targetX: 0, targetY: 0, targetZ: 0 };
		this.model = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
		this.background = [0.07, 0.09, 0.1, 1];
		this.lastViewProjection = m4Identity();
		this.lastModel = m4Identity();
		this.lastCameraBasis = {
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, -1],
		};
		this.overlay = null;
		this.gizmo = {
			center: null,
			radius: 72,
			hit: 12,
		};
	}

	load(payload) {
		let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
		for (const mesh of payload.meshes || []) {
			const positions = mesh.positions || [];
			for (let i = 0; i < positions.length; i += 3) {
				min[0] = Math.min(min[0], positions[i]);
				min[1] = Math.min(min[1], positions[i + 1]);
				min[2] = Math.min(min[2], positions[i + 2]);
				max[0] = Math.max(max[0], positions[i]);
				max[1] = Math.max(max[1], positions[i + 1]);
				max[2] = Math.max(max[2], positions[i + 2]);
			}
		}
		if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) {
			throw new Error("FBX 网格顶点为空，无法显示。");
		}
		const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
		const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
		const scale = 2 / span;
		this.bones = (payload.bones || []).map((bone) => ({ ...bone, t: [(bone.t[0] - (bone.parent < 0 ? center[0] : 0)) * scale, (bone.t[1] - (bone.parent < 0 ? center[1] : 0)) * scale, (bone.t[2] - (bone.parent < 0 ? center[2] : 0)) * scale] }));
		this.primaryBoneIndices = this.bones
			.map((bone, index) => isPrimaryControlBoneName(bone.name) ? index : -1)
			.filter((index) => index >= 0);
		const children = this.bones.map(() => []);
		this.bones.forEach((bone, index) => {
			if (bone.parent >= 0 && children[bone.parent]) children[bone.parent].push(index);
		});
		const collect = (index, out = new Set()) => {
			out.add(index);
			for (const child of children[index] || []) collect(child, out);
			return out;
		};
		this.subtreeSets = this.bones.map((_bone, index) => collect(index));
		const depthOf = (index) => {
			let depth = 0;
			let current = this.bones[index]?.parent ?? -1;
			const seen = new Set([index]);
			while (current >= 0 && !seen.has(current)) {
				seen.add(current);
				depth += 1;
				current = this.bones[current]?.parent ?? -1;
			}
			return depth;
		};
		this.boneDepths = this.bones.map((_bone, index) => depthOf(index));
		this.baseGlobals = this.computeGlobals({});
		this.joints = this.baseGlobals.map((matrix) => [matrix[12] || 0, matrix[13] || 0, matrix[14] || 0]);
		this.controlCenters = this.joints.map((point) => [...point]);
		this.jointMeshCenters = this.joints.map(() => null);
		this.boneBoundaryCenters = this.joints.map(() => null);
		this.pivotCenters = this.joints.map((point) => [...point]);
		const gl = this.gl;
		this.meshes = (payload.meshes || []).map((mesh, index) => {
			const positions = new Float32Array(mesh.positions.length);
			for (let i = 0; i < mesh.positions.length; i += 3) {
				positions[i] = (mesh.positions[i] - center[0]) * scale;
				positions[i + 1] = (mesh.positions[i + 1] - center[1]) * scale;
				positions[i + 2] = (mesh.positions[i + 2] - center[2]) * scale;
			}
			const item = {
				name: mesh.name,
				basePositions: positions,
				positions: new Float32Array(positions),
				normals: new Float32Array(mesh.normals),
				skinIndices: new Int16Array(mesh.skinIndices),
				skinWeights: new Float32Array(mesh.skinWeights),
				color: index % 2 ? [0.65, 0.8, 1.0] : [0.82, 0.88, 0.78],
				posBuffer: gl.createBuffer(),
				normBuffer: gl.createBuffer(),
			};
			gl.bindBuffer(gl.ARRAY_BUFFER, item.normBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, item.normals, gl.STATIC_DRAW);
			return item;
		});
		for (const mesh of this.meshes) {
			this.rebuildSmoothNormals(mesh);
		}
		this.rebuildControlCentersFromWeights();
		this.rebuildPivotCenters();
		this.pose = {};
		this.ikOffsets = {};
		this.selectedBone = 0;
		this.render();
	}

	rebuildControlCentersFromWeights() {
		const sums = this.bones.map(() => [0, 0, 0]);
		const weights = this.bones.map(() => 0);
		const jointSums = this.bones.map(() => [0, 0, 0]);
		const jointWeights = this.bones.map(() => 0);
		const boundarySums = this.bones.map(() => [0, 0, 0]);
		const boundaryWeights = this.bones.map(() => 0);
		for (const mesh of this.meshes) {
			const isJointMesh = String(mesh.name || "").toLowerCase().includes("joint");
			for (let i = 0; i < mesh.basePositions.length; i += 3) {
				const x = mesh.basePositions[i];
				const y = mesh.basePositions[i + 1];
				const z = mesh.basePositions[i + 2];
				const vi = (i / 3) * 4;
				const influences = new Map();
				for (let j = 0; j < 4; j++) {
					const weight = mesh.skinWeights[vi + j] || 0;
					const bone = mesh.skinIndices[vi + j] || 0;
					if (weight <= 0 || !sums[bone]) continue;
					influences.set(bone, (influences.get(bone) || 0) + weight);
					sums[bone][0] += x * weight;
					sums[bone][1] += y * weight;
					sums[bone][2] += z * weight;
					weights[bone] += weight;
					if (isJointMesh) {
						jointSums[bone][0] += x * weight;
						jointSums[bone][1] += y * weight;
						jointSums[bone][2] += z * weight;
						jointWeights[bone] += weight;
					}
				}
				for (const [bone, weight] of influences.entries()) {
					const parent = this.bones[bone]?.parent ?? -1;
					if (parent < 0 || !influences.has(parent)) continue;
					const boundaryWeight = Math.min(weight, influences.get(parent) || 0);
					if (boundaryWeight <= 0) continue;
					boundarySums[bone][0] += x * boundaryWeight;
					boundarySums[bone][1] += y * boundaryWeight;
					boundarySums[bone][2] += z * boundaryWeight;
					boundaryWeights[bone] += boundaryWeight;
				}
			}
		}
		this.controlCenters = this.controlCenters.map((fallback, index) => {
			if (weights[index] <= 0.0001) return fallback;
			return [
				sums[index][0] / weights[index],
				sums[index][1] / weights[index],
				sums[index][2] / weights[index],
			];
		});
		this.jointMeshCenters = this.joints.map((_fallback, index) => {
			if (jointWeights[index] <= 0.0001) return null;
			return [
				jointSums[index][0] / jointWeights[index],
				jointSums[index][1] / jointWeights[index],
				jointSums[index][2] / jointWeights[index],
			];
		});
		this.boneBoundaryCenters = this.joints.map((_fallback, index) => {
			if (boundaryWeights[index] <= 0.0001) return null;
			return [
				boundarySums[index][0] / boundaryWeights[index],
				boundarySums[index][1] / boundaryWeights[index],
				boundarySums[index][2] / boundaryWeights[index],
			];
		});
	}

	rebuildPivotCenters() {
		const midpoint = (a, b) => [
			(a[0] + b[0]) * 0.5,
			(a[1] + b[1]) * 0.5,
			(a[2] + b[2]) * 0.5,
		];
		this.pivotCenters = this.controlCenters.map((center, index) => {
			const bone = this.bones[index] || {};
			const parentIndex = Number(bone.parent ?? -1);
			const parent = parentIndex >= 0 ? this.controlCenters[parentIndex] : null;
			if (!parent) return center;
			const name = String(bone.name || "").replace(/^mixamorig:/, "").toLowerCase();
			if (name.includes("thumb") || name.includes("index") || name.includes("middle") || name.includes("ring") || name.includes("pinky") || name.includes("toebase")) {
				const jointCenter = this.jointMeshCenters[index];
				return jointCenter || midpoint(parent, center);
			}
			if (name === "lefthand" || name === "righthand" || name === "leftfoot" || name === "rightfoot") {
				const jointCenter = this.jointMeshCenters[index];
				return jointCenter || midpoint(parent, center);
			}
			const jointCenter = this.jointMeshCenters[index];
			if (jointCenter) return jointCenter;
			if (name.includes("forearm") || name === "leftleg" || name === "rightleg") {
				return midpoint(parent, center);
			}
			if (name.includes("arm") || name.includes("upleg") || name === "head") {
				return parent;
			}
			return midpoint(parent, center);
		});
	}

	rebuildSmoothNormals(mesh) {
		const normals = new Float32Array(mesh.basePositions.length);
		for (let i = 0; i < mesh.basePositions.length; i += 9) {
			const ax = mesh.basePositions[i], ay = mesh.basePositions[i + 1], az = mesh.basePositions[i + 2];
			const bx = mesh.basePositions[i + 3], by = mesh.basePositions[i + 4], bz = mesh.basePositions[i + 5];
			const cx = mesh.basePositions[i + 6], cy = mesh.basePositions[i + 7], cz = mesh.basePositions[i + 8];
			const ux = bx - ax, uy = by - ay, uz = bz - az;
			const vx = cx - ax, vy = cy - ay, vz = cz - az;
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			for (let j = 0; j < 9; j += 3) {
				normals[i + j] += nx;
				normals[i + j + 1] += ny;
				normals[i + j + 2] += nz;
			}
		}
		for (let i = 0; i < normals.length; i += 3) {
			const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
			normals[i] /= length;
			normals[i + 1] /= length;
			normals[i + 2] /= length;
		}
		mesh.normals = normals;
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
	}

	computeGlobals(pose) {
		const globals = [];
		for (let i = 0; i < this.bones.length; i++) {
			const bone = this.bones[i];
			const local = m4TRS(bone.t, bone.r, bone.s, pose?.[i] || [0, 0, 0]);
			globals[i] = bone.parent >= 0 ? m4Mul(globals[bone.parent], local) : local;
		}
		return globals;
	}

	poseHasRotation() {
		for (const value of Object.values(this.pose || {})) {
			if (!Array.isArray(value)) continue;
			if (Math.abs(Number(value[0] || 0)) > 0.001 || Math.abs(Number(value[1] || 0)) > 0.001 || Math.abs(Number(value[2] || 0)) > 0.001) {
				return true;
			}
		}
		return false;
	}

	poseMatrixForBone(bone, pivotOverride = null) {
		const rot = this.pose?.[bone] || [0, 0, 0];
		if (Math.abs(Number(rot[0] || 0)) <= 0.001 && Math.abs(Number(rot[1] || 0)) <= 0.001 && Math.abs(Number(rot[2] || 0)) <= 0.001) {
			return null;
		}
		const joint = pivotOverride || this.pivotCenters[bone] || this.controlCenters[bone] || this.joints[bone] || [0, 0, 0];
		const rotation = m4Mul(m4RotZ(Number(rot[2] || 0) * DEG), m4Mul(m4RotY(Number(rot[1] || 0) * DEG), m4RotX(Number(rot[0] || 0) * DEG)));
		return m4Mul(m4Translate(joint[0], joint[1], joint[2]), m4Mul(rotation, m4Translate(-joint[0], -joint[1], -joint[2])));
	}

	ikMatrixForBone(bone) {
		const offset = this.ikOffsets?.[bone];
		if (!Array.isArray(offset)) return null;
		if (Math.hypot(Number(offset[0] || 0), Number(offset[1] || 0), Number(offset[2] || 0)) <= 0.0001) return null;
		return m4Translate(Number(offset[0] || 0), Number(offset[1] || 0), Number(offset[2] || 0));
	}

	activeControls() {
		const controls = [];
		const indices = this.bones
			.map((_bone, index) => index)
			.sort((a, b) => (this.boneDepths[a] || 0) - (this.boneDepths[b] || 0));
		for (const index of indices) {
			const ikMat = this.ikMatrixForBone(index);
			const joint = this.pivotPoint(index, controls) || this.pivotCenters[index] || this.controlCenters[index] || this.joints[index] || [0, 0, 0];
			const offset = this.ikOffsets?.[index] || [0, 0, 0];
			const movedPivot = [joint[0] + (offset[0] || 0), joint[1] + (offset[1] || 0), joint[2] + (offset[2] || 0)];
			const rotMat = this.poseMatrixForBone(index, movedPivot);
			if (!rotMat && !ikMat) continue;
			controls.push({
				index,
				subtree: this.subtreeSets[index] || new Set([index]),
				matrix: rotMat && ikMat ? m4Mul(rotMat, ikMat) : (rotMat || ikMat),
			});
		}
		controls.sort((a, b) => (this.boneDepths[a.index] || 0) - (this.boneDepths[b.index] || 0));
		return controls;
	}

	pivotPoint(index, controls = null) {
		const joint = this.pivotCenters[index] || this.controlCenters[index] || this.joints[index];
		if (!joint) return null;
		let point = [joint[0], joint[1], joint[2]];
		for (const control of controls || this.activeControls()) {
			if (control.index === index || !control.subtree.has(index)) continue;
			point = m4Transform(control.matrix, point[0], point[1], point[2]);
		}
		return point;
	}

	transformedJoint(index, controls = null) {
		const joint = this.pivotPoint(index, controls);
		if (!joint) return null;
		let point = [joint[0], joint[1], joint[2]];
		for (const control of controls || this.activeControls()) {
			if (!control.subtree.has(index)) continue;
			point = m4Transform(control.matrix, point[0], point[1], point[2]);
		}
		return point;
	}

	setSelectedBone(index) {
		this.selectedBone = clamp(Number(index) || 0, 0, Math.max(0, this.bones.length - 1));
	}

	selectedHandSides() {
		const selected = String(this.bones[this.selectedBone || 0]?.name || "").replace(/^mixamorig:/, "").toLowerCase();
		if (selected.includes("left")) return ["left"];
		if (selected.includes("right")) return ["right"];
		return ["left", "right"];
	}

	setFingerPose(side, finger, curl = 0, spread = 0) {
		const sideText = side === "left" ? "left" : "right";
		const fingerText = String(finger || "").toLowerCase();
		for (let index = 0; index < this.bones.length; index++) {
			const name = String(this.bones[index]?.name || "").replace(/^mixamorig:/, "").toLowerCase();
			if (!name.startsWith(sideText) || !name.includes(fingerText)) continue;
			const match = name.match(/(\d+)(?!.*\d)/);
			const segment = clamp(match ? Number(match[1]) : 1, 1, 4);
			const segmentCurl = curl * (segment === 1 ? 0.68 : segment === 2 ? 0.92 : 1.0);
			const segmentSpread = segment === 1 ? spread : 0;
			const thumb = fingerText.includes("thumb");
			this.pose[index] = [
				clamp(segmentCurl, -45, 72),
				clamp(segmentSpread, -32, 32),
				thumb ? clamp(segmentSpread * 0.45, -18, 18) : 0,
			];
		}
	}

	setHandPose(side, rot = [0, 0, 0]) {
		const sideText = side === "left" ? "left" : "right";
		for (let index = 0; index < this.bones.length; index++) {
			const name = String(this.bones[index]?.name || "").replace(/^mixamorig:/, "").toLowerCase();
			if (name === `${sideText}hand` || name.endsWith(`${sideText}hand`)) {
				this.pose[index] = [
					clamp(rot[0] || 0, -90, 90),
					clamp(rot[1] || 0, -90, 90),
					clamp(rot[2] || 0, -90, 90),
				];
			}
		}
	}

	clearFingerPose(side) {
		const sideText = side === "left" ? "left" : "right";
		for (let index = 0; index < this.bones.length; index++) {
			const name = String(this.bones[index]?.name || "").replace(/^mixamorig:/, "").toLowerCase();
			if (!name.startsWith(sideText)) continue;
			if (name.includes("thumb") || name.includes("index") || name.includes("middle") || name.includes("ring") || name.includes("pinky")) {
				this.pose[index] = [0, 0, 0];
			}
		}
	}

	applyHandGesture(kind) {
		for (const side of this.selectedHandSides()) {
			this.clearFingerPose(side);
			this.setHandPose(side, [0, 0, 0]);
			const mirror = side === "left" ? 1 : -1;
			const curl = (finger, value, spread = 0) => this.setFingerPose(side, finger, value, spread * mirror);
			const open = () => {
				curl("thumb", 0, 16);
				curl("index", 0, -8);
				curl("middle", 0, -2);
				curl("ring", 0, 4);
				curl("pinky", 0, 10);
			};
			open();
			if (kind === "open" || kind === "vulcan" || kind === "down" || kind === "up") {
				if (kind === "down") this.setHandPose(side, [0, 0, -38 * mirror]);
				if (kind === "up") this.setHandPose(side, [0, 0, 38 * mirror]);
				if (kind === "vulcan") {
					curl("index", 0, -14);
					curl("middle", 0, -4);
					curl("ring", 0, 10);
					curl("pinky", 0, 18);
				}
			} else if (kind === "ok") {
				curl("thumb", 34, 20);
				curl("index", 40, -18);
				curl("middle", 4, 2);
				curl("ring", 6, 5);
				curl("pinky", 8, 10);
			} else if (kind === "pinch") {
				curl("thumb", 30, 18);
				curl("index", 28, -14);
				curl("middle", 22, 0);
				curl("ring", 34, 4);
				curl("pinky", 38, 10);
			} else if (kind === "smallpinch") {
				curl("thumb", 22, 18);
				curl("index", 18, -16);
				curl("middle", 6, 0);
				curl("ring", 16, 4);
				curl("pinky", 20, 10);
			} else if (kind === "peace") {
				curl("thumb", 20, 18);
				curl("ring", 48, 4);
				curl("pinky", 52, 10);
			} else if (kind === "cross") {
				curl("thumb", 24, 16);
				curl("index", 14, 16);
				curl("middle", 12, -16);
				curl("ring", 48, 4);
				curl("pinky", 52, 10);
			} else if (kind === "heart") {
				curl("thumb", 24, 18);
				curl("index", 24, -16);
				curl("middle", 46, 0);
				curl("ring", 50, 4);
				curl("pinky", 52, 10);
			} else if (kind === "love") {
				curl("middle", 50, 0);
				curl("ring", 52, 4);
			} else if (kind === "horns") {
				curl("thumb", 34, 18);
				curl("middle", 50, 0);
				curl("ring", 52, 4);
			} else if (kind === "call") {
				curl("index", 52, -8);
				curl("middle", 54, 0);
				curl("ring", 54, 4);
			} else if (kind === "point") {
				curl("thumb", 18, 16);
				curl("middle", 52, 0);
				curl("ring", 54, 4);
				curl("pinky", 54, 10);
			} else if (kind === "thumbup" || kind === "thumbdown") {
				curl("index", 54, -8);
				curl("middle", 54, 0);
				curl("ring", 54, 4);
				curl("pinky", 54, 10);
				this.setHandPose(side, [0, 0, (kind === "thumbup" ? -42 : 42) * mirror]);
			} else if (kind === "fist") {
				curl("thumb", 42, 16);
				curl("index", 54, -8);
				curl("middle", 54, 0);
				curl("ring", 54, 4);
				curl("pinky", 54, 10);
			}
		}
		this.render();
	}

	moveSelectedByScreenDelta(dx, dy) {
		const bone = this.selectedBone || 0;
		const offset = this.ikOffsets[bone] || [0, 0, 0];
		const factor = Math.max(0.001, this.camera.distance * 0.0018);
		const delta = v3Add(v3Scale(this.lastCameraBasis.right, dx * factor), v3Scale(this.lastCameraBasis.up, -dy * factor));
		this.ikOffsets[bone] = [offset[0] + delta[0], offset[1] + delta[1], offset[2] + delta[2]];
	}

	rotateSelectedByScreenDelta(dx, dy) {
		const bone = this.selectedBone || 0;
		const rot = this.pose[bone] || [0, 0, 0];
		this.pose[bone] = [
			clamp(rot[0] + dy * 0.45, -180, 180),
			clamp(rot[1] + dx * 0.45, -180, 180),
			rot[2],
		];
	}

	projectBone(index) {
		const joint = this.pivotPoint(index);
		if (!joint) return null;
		return projectPoint(this.lastViewProjection, m4Transform(this.lastModel, joint[0], joint[1], joint[2]), this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height);
	}

	selectedBoneScreenPoint() {
		const point = this.projectBone(this.selectedBone || 0);
		if (!point || point.z < -1 || point.z > 1) return null;
		return point;
	}

	gizmoRadius() {
		const width = this.canvas.clientWidth || this.canvas.width || 800;
		const height = this.canvas.clientHeight || this.canvas.height || 600;
		const viewportLimit = Math.max(22, Math.min(width, height) * 0.1);
		const distanceScale = clamp((this.camera.distance || 3.4) / 3.4, 0.45, 1.3);
		return clamp(42 * distanceScale, 20, Math.min(56, viewportLimit));
	}

	pickGizmo(clientX, clientY) {
		const center = this.selectedBoneScreenPoint();
		if (!center) return null;
		const local = viewportLocalPoint(this.canvas, clientX, clientY);
		const dx = local.x - center.x;
		const dy = local.y - center.y;
		const radius = this.gizmoRadius();
		const hit = Math.max(8, Math.min(14, radius * 0.24));
		const circleDist = Math.abs(Math.hypot(dx, dy) - radius);
		const xEllipse = Math.abs(Math.hypot(dx / 0.42, dy / 1.0) - radius);
		const yEllipse = Math.abs(Math.hypot(dx / 1.0, dy / 0.42) - radius);
		const hits = [
			{ axis: 2, dist: circleDist },
			{ axis: 0, dist: xEllipse },
			{ axis: 1, dist: yEllipse },
		].filter((item) => item.dist <= hit).sort((a, b) => a.dist - b.dist);
		return hits[0] || null;
	}

	pickBone(clientX, clientY) {
		const local = viewportLocalPoint(this.canvas, clientX, clientY);
		const x = local.x;
		const y = local.y;
		let best = -1;
		let bestDist = 999999;
		const candidates = this.primaryBoneIndices.length ? this.primaryBoneIndices : this.pivotCenters.map((_item, index) => index);
		for (const i of candidates) {
			const projected = this.projectBone(i);
			if (!projected || projected.z < -1 || projected.z > 1) continue;
			const dist = Math.hypot(projected.x - x, projected.y - y);
			if (dist < bestDist) {
				best = i;
				bestDist = dist;
			}
		}
		return bestDist <= 92 ? best : -1;
	}

	drawOverlay() {
		const overlay = this.overlay;
		if (!overlay) return;
		const width = this.canvas.clientWidth || this.canvas.width;
		const height = this.canvas.clientHeight || this.canvas.height;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (overlay.width !== Math.round(width * dpr) || overlay.height !== Math.round(height * dpr)) {
			overlay.width = Math.round(width * dpr);
			overlay.height = Math.round(height * dpr);
		}
		overlay.style.width = `${width}px`;
		overlay.style.height = `${height}px`;
		const ctx = overlay.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		if (!this.poseEditingEnabled) return;
		if (!this.pivotCenters.length) return;
		const points = this.pivotCenters.map((_joint, index) => this.projectBone(index));
		const drawSet = new Set(this.primaryBoneIndices.length ? this.primaryBoneIndices : this.bones.map((_bone, index) => index));
		for (const i of drawSet) {
			const point = points[i];
			if (!point || point.z < -1 || point.z > 1) continue;
			const selected = i === this.selectedBone;
			ctx.beginPath();
			ctx.arc(point.x, point.y, selected ? 6 : 3.2, 0, Math.PI * 2);
			ctx.fillStyle = selected ? "rgba(255, 226, 124, 0.96)" : "rgba(154, 214, 255, 0.68)";
			ctx.fill();
			if (selected) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = "rgba(30, 20, 0, 0.85)";
				ctx.stroke();
			}
		}
		const selectedPoint = this.selectedBoneScreenPoint();
		if (selectedPoint) {
			const r = this.gizmoRadius();
			ctx.lineWidth = 3;
			ctx.globalAlpha = 0.96;
			ctx.strokeStyle = "#2f8cff";
			ctx.beginPath();
			ctx.arc(selectedPoint.x, selectedPoint.y, r, 0, Math.PI * 2);
			ctx.stroke();
			ctx.strokeStyle = "#f04a5f";
			ctx.beginPath();
			ctx.ellipse(selectedPoint.x, selectedPoint.y, r * 0.42, r, 0, 0, Math.PI * 2);
			ctx.stroke();
			ctx.strokeStyle = "#75c831";
			ctx.beginPath();
			ctx.ellipse(selectedPoint.x, selectedPoint.y, r, r * 0.42, 0, 0, Math.PI * 2);
			ctx.stroke();
			ctx.globalAlpha = 1;
		}
	}

	skinMeshes() {
		if (!this.poseEditingEnabled) {
			for (const mesh of this.meshes) {
				mesh.positions.set(mesh.basePositions);
			}
			return;
		}
		if (!this.poseHasRotation() && Object.keys(this.ikOffsets || {}).length <= 0) {
			for (const mesh of this.meshes) {
				mesh.positions.set(mesh.basePositions);
			}
			return;
		}
		const controls = this.activeControls();
		for (const mesh of this.meshes) {
			for (let i = 0; i < mesh.basePositions.length; i += 3) {
				const x = mesh.basePositions[i], y = mesh.basePositions[i + 1], z = mesh.basePositions[i + 2];
				let ox = x, oy = y, oz = z;
				const vi = (i / 3) * 4;
				for (const control of controls) {
					let controlled = false;
					for (let j = 0; j < 4; j++) {
						const weight = mesh.skinWeights[vi + j] || 0;
						if (!weight) continue;
						const bone = mesh.skinIndices[vi + j] || 0;
						if (control.subtree.has(bone)) {
							controlled = true;
							break;
						}
					}
					if (!controlled) continue;
					const p = m4Transform(control.matrix, ox, oy, oz);
					ox = p[0];
					oy = p[1];
					oz = p[2];
				}
				mesh.positions[i] = ox; mesh.positions[i + 1] = oy; mesh.positions[i + 2] = oz;
			}
		}
	}

	render() {
		const gl = this.gl;
		const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
			this.canvas.width = Math.round(w * dpr);
			this.canvas.height = Math.round(h * dpr);
		}
		this.skinMeshes();
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(...this.background);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.useProgram(this.program);
		const yaw = this.camera.yaw * DEG, pitch = this.camera.pitch * DEG, dist = this.camera.distance;
		const target = [this.camera.targetX || 0, this.camera.targetY || 0, this.camera.targetZ || 0];
		const eye = [
			target[0] + Math.sin(yaw) * Math.cos(pitch) * dist,
			target[1] + Math.sin(pitch) * dist,
			target[2] + Math.cos(yaw) * Math.cos(pitch) * dist,
		];
		const forward = v3Normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
		const right = v3Normalize(v3Cross(forward, [0, 1, 0]));
		const up = v3Normalize(v3Cross(right, forward));
		this.lastCameraBasis = { right, up, forward };
		const view = lookAt(eye, target, [0, 1, 0]);
		const proj = perspective(42 * DEG, this.canvas.width / Math.max(1, this.canvas.height), 0.01, 100);
		const model = m4Mul(m4Translate(this.model.x, this.model.y, this.model.z), m4Mul(m4RotZ(this.model.rz * DEG), m4Mul(m4RotY(this.model.ry * DEG), m4Mul(m4RotX(this.model.rx * DEG), m4Scale(this.model.scale, this.model.scale, this.model.scale)))));
		const viewProjection = m4Mul(proj, view);
		const mvp = m4Mul(viewProjection, model);
		this.lastModel = model;
		this.lastViewProjection = viewProjection;
		gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_mvp"), false, new Float32Array(mvp));
		gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_model"), false, new Float32Array(model));
		const aPos = gl.getAttribLocation(this.program, "a_position");
		const aNormal = gl.getAttribLocation(this.program, "a_normal");
		for (const mesh of this.meshes) {
			gl.uniform3fv(gl.getUniformLocation(this.program, "u_color"), new Float32Array(mesh.color));
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
			gl.enableVertexAttribArray(aPos);
			gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuffer);
			gl.enableVertexAttribArray(aNormal);
			gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
			gl.drawArrays(gl.TRIANGLES, 0, mesh.positions.length / 3);
		}
		this.drawOverlay();
	}
}

function createNumber(label, value, min, max, step, onInput) {
	const box = document.createElement("label");
	box.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;color:#dce9e4;font:700 12px/1.2 system-ui";
	const top = document.createElement("span");
	top.textContent = label;
	const input = document.createElement("input");
	input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = value;
	const val = document.createElement("span");
	val.textContent = String(value);
	val.style.cssText = "color:#8fd0ff;font-weight:800";
	input.addEventListener("input", () => { val.textContent = input.value; onInput(Number(input.value)); });
	box.append(top, input, val);
	return { box, input, val };
}

function syncCapture(node, renderer) {
	const width = Number(getWidget(node, "width", 1024));
	const height = Number(getWidget(node, "height", 1024));
	const oldStyle = renderer.canvas.style.cssText;
	renderer.canvas.style.width = `${width}px`;
	renderer.canvas.style.height = `${height}px`;
	renderer.render();
	renderer.gl.finish();
	setWidget(node, "image_data", renderer.canvas.toDataURL("image/png"));
	setWidget(node, "pose_json", JSON.stringify({
		fbx_path: getWidget(node, "fbx_path", ""),
		width,
		height,
		model: renderer.model,
		camera: renderer.camera,
		pose: renderer.pose,
	}, null, 2));
	renderer.canvas.style.cssText = oldStyle;
	renderer.render();
}

function syncAllPoseStudios() {
	const nodes = app?.graph?._nodes || [];
	for (const node of nodes) {
		if (node?.comfyClass !== NODE_CLASS && node?.type !== NODE_CLASS) continue;
		if (node.__gjjFbxRenderer) syncCapture(node, node.__gjjFbxRenderer);
	}
}

function buildPanel(node) {
	for (const item of node.widgets || []) {
		if (HIDDEN_WIDGETS.has(String(item.name || ""))) hideWidget(item);
	}
	GJJ_Utils.removeHiddenInputSockets?.(node, HIDDEN_WIDGETS);
	const panel = document.createElement("div");
	panel.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"height:720px",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:8px",
		"background:#10181d",
		"border:1px solid #314047",
		"border-radius:8px",
		"overflow:hidden",
	].join(";");

	const top = document.createElement("div");
	top.style.cssText = "display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:center";
	const select = document.createElement("select");
	select.style.display = "none";
	const pathInput = document.createElement("input");
	pathInput.value = getWidget(node, "fbx_path", "");
	pathInput.style.cssText = "display:none";
	const genderBar = document.createElement("div");
	genderBar.style.cssText = "display:flex;align-items:center;gap:4px";
	function genderButton(icon, title, fileName) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = icon;
		btn.title = title;
		btn.style.cssText = "width:38px;height:32px;display:grid;place-items:center;background:#1c2b31;color:#effaf6;border:1px solid #40555f;border-radius:8px;font:800 19px/1 system-ui;cursor:pointer";
		btn.onclick = () => chooseModelFile(fileName);
		genderBar.append(btn);
		return btn;
	}
	const femaleBtn = genderButton("♀️", "载入 X_Bot.fbx", "X_Bot.fbx");
	const maleBtn = genderButton("♂️", "载入 Y_Bot.fbx", "Y_Bot.fbx");
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;align-items:center;gap:3px;justify-content:flex-end;flex-wrap:wrap";
	function toolButton(icon, title, onClick = null) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = icon;
		btn.title = title;
		btn.style.cssText = "width:28px;height:28px;display:grid;place-items:center;background:#1c2b31;color:#effaf6;border:1px solid #40555f;border-radius:7px;font:700 16px/1 system-ui;cursor:pointer";
		if (onClick) btn.onclick = onClick;
		toolbar.append(btn);
		return btn;
	}
	const loadBtn = toolButton("📂", "载入 FBX");
	const captureBtn = toolButton("📸", "捕获当前画面到输出");
	const runBtn = toolButton("▶️", "执行当前节点并输出图片");
	const downloadBtn = toolButton("💾", "下载 PNG");
	const gestureButtons = [
		["🖐️", "open", "手势：张开手"],
		["🖖", "vulcan", "手势：瓦肯"],
		["🫳", "down", "手势：手心向下"],
		["🫴", "up", "手势：手心向上"],
		["👌", "ok", "手势：OK"],
		["🤌", "pinch", "手势：捏合"],
		["🤏", "smallpinch", "手势：小捏"],
		["✌️", "peace", "手势：胜利"],
		["🤞", "cross", "手势：交叉手指"],
		["🫰", "heart", "手势：比心"],
		["🤟", "love", "手势：我爱你"],
		["🤘", "horns", "手势：摇滚"],
		["🤙", "call", "手势：电话"],
		["👉", "point", "手势：指向"],
		["👍", "thumbup", "手势：赞"],
		["👎", "thumbdown", "手势：踩"],
		["🤜", "fist", "手势：拳头"],
	].map(([icon, key, title]) => [toolButton(icon, title), key]);
	const viewBtn = toolButton("👁️", "视图模式");
	const settingsBtn = toolButton("⚙️", "显示/隐藏详细参数");
	top.append(genderBar, pathInput, toolbar);
	top.append(select);

	const status = document.createElement("div");
	status.style.cssText = [
		"display:none",
		"min-height:28px",
		"padding:6px 8px",
		"border:1px solid #6b4450",
		"border-radius:6px",
		"background:#25171b",
		"color:#ffd7df",
		"font:700 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"white-space:normal",
	].join(";");
	function setStatus(message, ok = false) {
		const text = String(message || "").trim();
		status.style.display = text ? "block" : "none";
		status.style.borderColor = ok ? "#3f6652" : "#6b4450";
		status.style.background = ok ? "#14251d" : "#25171b";
		status.style.color = ok ? "#c9f7dc" : "#ffd7df";
		status.textContent = text;
	}

	const viewport = document.createElement("div");
	viewport.style.cssText = "position:relative;width:100%;height:410px;background:#111;border:1px solid #314047;border-radius:6px;overflow:hidden";
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "width:100%;height:100%;background:#111;display:block;touch-action:none";
	const overlay = document.createElement("canvas");
	overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
	viewport.append(canvas, overlay);
	const viewGizmo = document.createElement("div");
	viewGizmo.style.cssText = "position:absolute;right:10px;top:10px;width:112px;height:170px;pointer-events:auto;user-select:none;z-index:4";
	let viewGizmoDrag = null;
	viewGizmo.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); });
	viewGizmo.addEventListener("mousedown", (event) => {
		if (!renderer) return;
		event.preventDefault();
		event.stopPropagation();
		viewGizmoDrag = {
			x: event.clientX,
			y: event.clientY,
			yaw: renderer.camera.yaw,
			pitch: renderer.camera.pitch,
		};
	});
	viewGizmo.addEventListener("wheel", (event) => event.stopPropagation(), { passive: false });
	function viewDot(label, title, left, top, color, onClick) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = label;
		btn.title = title;
		btn.style.cssText = [
			"position:absolute",
			`left:${left}px`,
			`top:${top}px`,
			"width:26px",
			"height:26px",
			"border-radius:50%",
			"border:1px solid rgba(255,255,255,.42)",
			`background:${color}`,
			"color:#061116",
			"font:800 13px/1 system-ui",
			"display:grid",
			"place-items:center",
			"box-shadow:0 2px 8px rgba(0,0,0,.35)",
			"cursor:pointer",
		].join(";");
		btn.onclick = (event) => { event.stopPropagation(); onClick?.(); };
		viewGizmo.append(btn);
		return btn;
	}
	function viewIcon(label, title, top, onClick) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = label;
		btn.title = title;
		btn.style.cssText = [
			"position:absolute",
			"right:4px",
			`top:${top}px`,
			"width:38px",
			"height:38px",
			"border-radius:50%",
			"border:1px solid rgba(255,255,255,.18)",
			"background:rgba(18,24,28,.72)",
			"color:#f3fbff",
			"font:800 20px/1 system-ui",
			"display:grid",
			"place-items:center",
			"box-shadow:0 4px 12px rgba(0,0,0,.35)",
			"cursor:pointer",
		].join(";");
		btn.onclick = (event) => { event.stopPropagation(); onClick?.(); };
		viewGizmo.append(btn);
		return btn;
	}
	const axisLine = document.createElement("div");
	axisLine.style.cssText = "position:absolute;left:24px;top:21px;width:68px;height:74px;border-left:2px solid rgba(61,143,255,.45);border-bottom:2px solid rgba(126,199,46,.45);transform:skew(-18deg);pointer-events:none";
	viewGizmo.append(axisLine);
	viewDot("Z", "顶视图", 20, 0, "#3e9aff", () => { if (!renderer) return; renderer.camera.yaw = 0; renderer.camera.pitch = 70; renderer.render(); });
	viewDot("Y", "正视图", 78, 42, "#8ccc2f", () => { if (!renderer) return; renderer.camera.yaw = 0; renderer.camera.pitch = 0; renderer.render(); });
	viewDot("X", "侧视图", 50, 64, "#ff4964", () => { if (!renderer) return; renderer.camera.yaw = 90; renderer.camera.pitch = 0; renderer.render(); });
	viewDot("", "重置斜视图", 43, 35, "rgba(255,255,255,.18)", () => { if (!renderer) return; renderer.camera.yaw = 25; renderer.camera.pitch = 12; renderer.render(); });
	viewIcon("＋", "放大视图", 105, () => { if (!renderer) return; renderer.camera.distance = clamp(renderer.camera.distance * 0.82, 0.6, 12); renderer.render(); });
	viewIcon("✋", "视图回中", 148, () => { if (!renderer) return; renderer.camera.targetX = 0; renderer.camera.targetY = 0; renderer.camera.targetZ = 0; renderer.render(); });
	viewport.append(viewGizmo);
	window.addEventListener("mousemove", (event) => {
		if (!renderer || !viewGizmoDrag) return;
		event.preventDefault();
		const dx = event.clientX - viewGizmoDrag.x;
		const dy = event.clientY - viewGizmoDrag.y;
		renderer.camera.yaw = ((viewGizmoDrag.yaw + dx * 0.55 + 180) % 360) - 180;
		renderer.camera.pitch = clamp(viewGizmoDrag.pitch - dy * 0.45, -70, 70);
		renderer.render();
	});
	window.addEventListener("mouseup", () => {
		viewGizmoDrag = null;
	});
	let renderer = null;
	try {
		renderer = new FbxRenderer(canvas);
		renderer.overlay = overlay;
	} catch (error) {
		setStatus(error?.message || error, false);
	}

	const modeButtons = {
		[INTERACTION_MODES.view]: viewBtn,
	};
	function setInteractionMode(mode) {
		if (renderer) renderer.interactionMode = mode;
		for (const [key, button] of Object.entries(modeButtons)) {
			const active = key === mode;
			button.style.background = active ? "#396b7a" : "#1c2b31";
			button.style.borderColor = active ? "#74aabc" : "#40555f";
			button.style.color = active ? "#ffffff" : "#dce9e4";
		}
	}
	viewBtn.onclick = () => setInteractionMode(INTERACTION_MODES.view);

	const controls = document.createElement("div");
	controls.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;min-height:0";
	let detailsOpen = false;
	function setDetailsOpen(open) {
		detailsOpen = Boolean(open);
		controls.style.display = detailsOpen ? "grid" : "none";
		settingsBtn.style.background = detailsOpen ? "#396b7a" : "#1c2b31";
		settingsBtn.style.borderColor = detailsOpen ? "#74aabc" : "#40555f";
		panel.style.height = detailsOpen ? "720px" : "560px";
		if (node?.setSize) node.setSize([node.size?.[0] || 920, detailsOpen ? 820 : 640]);
		if (renderer) setTimeout(() => renderer.render(), 0);
	}
	const boneBox = document.createElement("div");
	const modelBox = document.createElement("div");
	const camBox = document.createElement("div");
	for (const box of [boneBox, modelBox, camBox]) box.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px;background:#152127;border:1px solid #304048;border-radius:8px;min-width:0";
	boneBox.style.display = "none";
	controls.append(modelBox, camBox);

	const boneSelect = document.createElement("select");
	boneSelect.style.cssText = "height:30px;background:#0d1317;color:#dce9e4;border:1px solid #3a4b52;border-radius:6px;min-width:0";
	boneBox.append(boneSelect);
	const boneSliders = ["X", "Y", "Z"].map((axis, idx) => createNumber(`骨骼旋转 ${axis}`, 0, -180, 180, 1, (value) => {
		if (!renderer) return;
		const bone = Number(boneSelect.value || 0);
		renderer.pose[bone] ||= [0, 0, 0];
		renderer.pose[bone][idx] = value;
		renderer.render();
	}));
	boneSliders.forEach((item) => boneBox.append(item.box));
	const resetBone = document.createElement("button");
	resetBone.type = "button"; resetBone.textContent = "重置当前骨骼";
	resetBone.style.cssText = "height:30px;background:#26343b;color:#dce9e4;border:1px solid #455963;border-radius:6px;font-weight:800";
	resetBone.onclick = () => {
		if (!renderer) return;
		const bone = Number(boneSelect.value || 0);
		renderer.pose[bone] = [0, 0, 0];
		renderer.ikOffsets[bone] = [0, 0, 0];
		boneSliders.forEach((item) => { item.input.value = 0; item.val.textContent = "0"; });
		renderer.render();
	};
	boneBox.append(resetBone);

	function setSelectedBone(index, updateSelect = true) {
		if (!renderer) return;
		renderer.setSelectedBone(index);
		if (updateSelect && boneSelect.options.length) {
			boneSelect.value = String(renderer.selectedBone);
		}
		const values = renderer.pose[renderer.selectedBone] || [0, 0, 0];
		boneSliders.forEach((item, idx) => {
			const value = Number(values[idx] || 0);
			item.input.value = String(value);
			item.val.textContent = String(Math.round(value * 100) / 100);
		});
		const boneName = renderer.bones[renderer.selectedBone]?.name?.replace(/^mixamorig:/, "") || "";
		if (boneName) setStatus(`当前选中：${boneName}。拖红/绿/蓝旋转环可按 X/Y/Z 轴旋转；Shift+左键旋转视图，Ctrl+左键平移，Alt+左键缩放。`, true);
		renderer.render();
	}

	const modelControls = [
		["位置 X", "x", -2, 2, 0.01], ["位置 Y", "y", -2, 2, 0.01], ["旋转 Y", "ry", -180, 180, 1], ["缩放", "scale", 0.1, 3, 0.01],
	];
	for (const [label, key, min, max, step] of modelControls) {
		const item = createNumber(label, renderer?.model?.[key] ?? (key === "scale" ? 1 : 0), min, max, step, (value) => { if (!renderer) return; renderer.model[key] = value; renderer.render(); });
		modelBox.append(item.box);
	}

	for (const [label, key, min, max, step] of [["相机水平", "yaw", -180, 180, 1], ["相机俯仰", "pitch", -70, 70, 1], ["相机距离", "distance", 1, 8, 0.05]]) {
		const item = createNumber(label, renderer?.camera?.[key] ?? (key === "distance" ? 3.4 : 0), min, max, step, (value) => { if (!renderer) return; renderer.camera[key] = value; renderer.render(); });
		camBox.append(item.box);
	}
	const sizeRow = document.createElement("div");
	sizeRow.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px";
	for (const name of ["width", "height"]) {
		const input = document.createElement("input");
		input.type = "number"; input.min = "128"; input.max = "4096"; input.step = "64";
		input.value = getWidget(node, name, name === "width" ? 1024 : 1024);
		input.style.cssText = "width:100%;height:30px;background:#0d1317;color:#dce9e4;border:1px solid #3a4b52;border-radius:6px;padding:0 6px";
		input.addEventListener("change", () => setWidget(node, name, Math.max(128, Math.min(4096, Number(input.value) || 1024))));
		sizeRow.append(input);
	}
	camBox.append(sizeRow);

	function updateGenderButtons(path = "") {
		const text = String(path || "").toLowerCase();
		for (const [button, active] of [
			[femaleBtn, text.includes("x_bot.fbx")],
			[maleBtn, text.includes("y_bot.fbx")],
		]) {
			button.style.background = active ? "#396b7a" : "#1c2b31";
			button.style.borderColor = active ? "#74aabc" : "#40555f";
		}
	}

	function chooseModelFile(fileName) {
		const target = String(fileName || "").toLowerCase();
		let found = "";
		for (const option of Array.from(select.options || [])) {
			if (String(option.textContent || option.value || "").toLowerCase().includes(target)) {
				found = option.value;
				break;
			}
		}
		if (!found) {
			found = String(pathInput.value || "").replace(/[^\\/]+$/, fileName);
		}
		if (found) {
			select.value = found;
			pathInput.value = found;
			updateGenderButtons(found);
			loadModel();
		}
	}

	async function loadList() {
		const res = await fetch(`${ROUTE_BASE}/list`);
		if (!res.ok) {
			throw new Error(`接口 /list 返回 ${res.status}。请重启 ComfyUI 后端，让新节点注册接口。`);
		}
		const data = await res.json();
		select.innerHTML = "";
		for (const file of data.files || []) {
			const option = document.createElement("option");
			option.value = file.path;
			option.textContent = file.name;
			select.append(option);
		}
		if (select.options.length) {
			select.value = pathInput.value || select.options[0].value;
			pathInput.value = select.value;
			setWidget(node, "fbx_path", select.value);
			updateGenderButtons(select.value);
		}
	}

	async function loadModel() {
		const path = pathInput.value.trim() || select.value;
		if (!path) return;
		if (!renderer) {
			setStatus("WebGL 初始化失败，无法载入 3D 模型。", false);
			return;
		}
		setWidget(node, "fbx_path", path);
		updateGenderButtons(path);
		loadBtn.textContent = "⏳";
		loadBtn.title = "载入中";
		setStatus("");
		try {
			const res = await fetch(`${ROUTE_BASE}/model?path=${encodeURIComponent(path)}`);
			const text = await res.text();
			let data = null;
			try {
				data = JSON.parse(text);
			} catch (_) {
				throw new Error(`接口 /model 返回的不是 JSON（HTTP ${res.status}）。请重启 ComfyUI 后端并刷新页面。`);
			}
			if (!res.ok) throw new Error(data?.error || `接口 /model 返回 ${res.status}`);
			if (!data.ok) throw new Error(data.error || "FBX 解析失败");
			if (!Array.isArray(data.meshes) || data.meshes.length <= 0) {
				throw new Error("FBX 中没有解析到可显示网格。");
			}
			renderer.load(data);
			boneSelect.innerHTML = "";
			renderer.bones.forEach((bone, idx) => {
				const option = document.createElement("option");
				option.value = String(idx);
				option.textContent = bone.name.replace(/^mixamorig:/, "");
				boneSelect.append(option);
			});
			if (renderer.poseEditingEnabled) {
				setSelectedBone(0);
			} else {
				renderer.render();
			}
			setInteractionMode(renderer.interactionMode || INTERACTION_MODES.view);
			loadBtn.textContent = "📂";
			loadBtn.title = "载入 FBX";
			setStatus(`已载入 ${data.name || "FBX"}：${data.meshes.length} 个网格，${(data.bones || []).length} 根骨骼。点选关节后拖红/绿/蓝旋转环；不启用 IK 平移。`, true);
		} catch (error) {
			loadBtn.textContent = "⚠️";
			loadBtn.title = "载入失败";
			setStatus(error?.message || String(error), false);
			console.error("[GJJ FBX Pose Studio]", error);
		}
	}

	select.addEventListener("change", () => { pathInput.value = select.value; loadModel(); });
	loadBtn.onclick = loadModel;
	captureBtn.onclick = () => renderer && syncCapture(node, renderer);
	runBtn.onclick = async () => { if (!renderer) return; syncCapture(node, renderer); await queueOnlyCurrentNode(node); };
	downloadBtn.onclick = () => {
		if (!renderer) return;
		syncCapture(node, renderer);
		const link = document.createElement("a");
		link.href = getWidget(node, "image_data", "");
		link.download = `gjj_fbx_pose_${Date.now()}.png`;
		link.click();
	};
	for (const [button, gesture] of gestureButtons) {
		button.onclick = () => renderer?.applyHandGesture(gesture);
	}
	settingsBtn.onclick = () => setDetailsOpen(!detailsOpen);
	boneSelect.addEventListener("change", () => {
		setSelectedBone(Number(boneSelect.value || 0), false);
	});

	let dragState = null;
	viewport.addEventListener("contextmenu", (event) => event.preventDefault());
	function consumeViewportEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}
	viewport.addEventListener("mousedown", (event) => {
		if (!renderer) return;
		consumeViewportEvent(event);
		const gizmoHit = renderer.poseEditingEnabled ? renderer.pickGizmo(event.clientX, event.clientY) : null;
		if (renderer.poseEditingEnabled && !gizmoHit) {
			const picked = renderer.pickBone(event.clientX, event.clientY);
			if (picked >= 0) setSelectedBone(picked);
		}
		const mode = renderer.poseEditingEnabled ? (renderer.interactionMode || INTERACTION_MODES.view) : INTERACTION_MODES.view;
		let action = mode;
		if (gizmoHit) {
			action = "rotateGizmo";
			renderer.activeControlBone = renderer.selectedBone || 0;
		} else if (event.ctrlKey) {
			action = "panView";
		} else if (event.altKey) {
			action = "zoomView";
		} else if (event.shiftKey) {
			action = "rotateView";
		} else if (mode === INTERACTION_MODES.view) {
			action = "pickOnly";
		}
		dragState = {
			x: event.clientX,
			y: event.clientY,
			startX: event.clientX,
			startY: event.clientY,
			moved: false,
			action,
			gizmoAxis: gizmoHit?.axis,
			gizmoCenter: renderer.selectedBoneScreenPoint(),
			startPose: renderer.pose[renderer.selectedBone] ? [...renderer.pose[renderer.selectedBone]] : [0, 0, 0],
			startAngle: (() => {
				const center = renderer.selectedBoneScreenPoint();
				if (!center) return 0;
				const local = viewportLocalPoint(viewport, event.clientX, event.clientY);
				return Math.atan2(local.y - center.y, local.x - center.x);
			})(),
		};
	}, { capture: true });
	window.addEventListener("mousemove", (event) => {
		if (!renderer || !dragState) return;
		consumeViewportEvent(event);
		const dx = event.clientX - dragState.x;
		const dy = event.clientY - dragState.y;
		dragState.x = event.clientX;
		dragState.y = event.clientY;
		if (!dragState.moved && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 3) {
			event.preventDefault();
			return;
		}
		dragState.moved = true;
		if (dragState.action === "rotateView") {
			renderer.camera.yaw = ((renderer.camera.yaw + dx * 0.35 + 180) % 360) - 180;
			renderer.camera.pitch = clamp(renderer.camera.pitch - dy * 0.25, -70, 70);
		} else if (dragState.action === "panView") {
			const factor = Math.max(0.001, renderer.camera.distance * 0.0018);
			const delta = v3Add(v3Scale(renderer.lastCameraBasis.right, -dx * factor), v3Scale(renderer.lastCameraBasis.up, dy * factor));
			renderer.camera.targetX += delta[0];
			renderer.camera.targetY += delta[1];
			renderer.camera.targetZ += delta[2];
		} else if (dragState.action === "zoomView") {
			const factor = Math.exp(dy * 0.01);
			renderer.camera.distance = clamp(renderer.camera.distance * factor, 0.6, 12);
		} else if (dragState.action === "rotateGizmo") {
			const center = dragState.gizmoCenter || renderer.selectedBoneScreenPoint();
			if (center) {
				const local = viewportLocalPoint(viewport, event.clientX, event.clientY);
				const angle = Math.atan2(local.y - center.y, local.x - center.x);
				let delta = (angle - dragState.startAngle) / DEG;
				while (delta > 180) delta -= 360;
				while (delta < -180) delta += 360;
				const bone = renderer.selectedBone || 0;
				const axis = dragState.gizmoAxis ?? 2;
				const next = [...(dragState.startPose || [0, 0, 0])];
				next[axis] = clamp(next[axis] + delta, -180, 180);
				renderer.pose[bone] = next;
				setSelectedBone(bone);
			}
		} else if (dragState.action === INTERACTION_MODES.ik) {
			renderer.moveSelectedByScreenDelta(dx, dy);
		} else if (dragState.action === INTERACTION_MODES.rotate) {
			renderer.rotateSelectedByScreenDelta(dx, dy);
			setSelectedBone(renderer.selectedBone);
		}
		renderer.render();
	}, { capture: true });
	window.addEventListener("mouseup", (event) => {
		if (!dragState) return;
		consumeViewportEvent(event);
		dragState = null;
	}, { capture: true });
	viewport.addEventListener("wheel", (event) => {
		if (!renderer) return;
		consumeViewportEvent(event);
		const factor = Math.exp(event.deltaY * 0.001);
		renderer.camera.distance = clamp(renderer.camera.distance * factor, 0.6, 12);
		renderer.render();
	}, { passive: false });

	panel.append(top, status, viewport, controls);
	node.__gjjFbxRenderer = renderer;
	setInteractionMode(INTERACTION_MODES.view);
	setDetailsOpen(false);
	loadList().then(loadModel).catch((error) => {
		setStatus(error?.message || String(error), false);
		console.warn("[GJJ FBX Pose Studio] 文件列表读取失败", error);
	});
	return panel;
}

app.registerExtension({
	name: "GJJ.FBXPoseStudio",
	beforeQueuePrompt() {
		syncAllPoseStudios();
	},
	beforeQueued() {
		syncAllPoseStudios();
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== NODE_CLASS) return;
		const original = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			original?.apply(this, arguments);
			if (this.__gjjFbxPanelReady) return;
			this.__gjjFbxPanelReady = true;
			this.size = [920, 820];
			this.addDOMWidget?.("gjj_fbx_pose_studio", "div", buildPanel(this), { serialize: false, hideOnZoom: false });
		};
	},
});

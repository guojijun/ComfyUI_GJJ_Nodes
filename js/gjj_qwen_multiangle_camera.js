import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_QwenMultiangleCameraNode";

    const PROP_KEY = "gjjMultiangleCameraState";

    const BOOLEAN_NAMES = ["camera_view"];

    const AZIMUTH_PRESETS = [
        { value: 0, label: "正面" },
        { value: 45, label: "右前" },
        { value: 90, label: "右侧" },
        { value: 135, label: "右后" },
        { value: 180, label: "背面" },
        { value: 225, label: "左后" },
        { value: 270, label: "左侧" },
        { value: 315, label: "左前" },
    ];

    const ELEVATION_PRESETS = [
        { value: -25, label: "仰拍" },
        { value: 0, label: "平视" },
        { value: 30, label: "高角度" },
        { value: 50, label: "俯拍" },
    ];

    const DISTANCE_PRESETS = [
        { value: 1, label: "远景" },
        { value: 5, label: "中景" },
        { value: 8, label: "特写" },
    ];

    const STYLE_ID = "gjj-multiangle-camera-styles";
    const THREE_SCRIPT_URL = "/extensions/ComfyUI_GJJ_Nodes/three.umd.js";
    let threeLoadPromise = null;

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.gjj-ma-container {
    width: 100%;
    position: relative;
    background: #0a0a0f;
    border-radius: 8px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.gjj-ma-canvas-wrap {
    width: 100%;
    height: 320px;
    position: relative;
    min-height: 280px;
}
.gjj-ma-canvas-wrap canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100% !important;
    height: 100% !important;
}
.gjj-ma-prompt-bar {
    position: absolute;
    top: 6px;
    left: 6px;
    right: 6px;
    background: rgba(10,10,15,0.92);
    border: 1px solid rgba(233,61,130,0.35);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
    color: #E93D82;
    backdrop-filter: blur(4px);
    font-family: Consolas, Monaco, monospace;
    word-break: break-all;
    line-height: 1.4;
    z-index: 2;
    pointer-events: none;
}
.gjj-ma-info-bar {
    position: absolute;
    bottom: 6px;
    left: 6px;
    right: 6px;
    background: rgba(10,10,15,0.92);
    border: 1px solid rgba(233,61,130,0.3);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
    color: #e0e0e0;
    backdrop-filter: blur(4px);
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 4px;
    pointer-events: none;
}
.gjj-ma-info-row {
    display: flex;
    justify-content: space-around;
    align-items: center;
}
.gjj-ma-param { text-align: center; }
.gjj-ma-param-value { font-weight: 600; font-size: 13px; }
.gjj-ma-param-value.az { color: #E93D82; }
.gjj-ma-param-value.el { color: #00FFD0; }
.gjj-ma-param-value.dist { color: #FFB800; }
.gjj-ma-param-label { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.gjj-ma-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: #111118;
    border-top: 1px solid #222;
    flex-wrap: wrap;
}
.gjj-ma-toolbar-btn {
    height: 26px;
    min-width: 26px;
    border-radius: 4px;
    border: 1px solid rgba(233,61,130,0.35);
    background: rgba(10,10,15,0.8);
    color: #E93D82;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    transition: all 0.15s ease;
    flex-shrink: 0;
    padding: 0 6px;
    user-select: none;
}
.gjj-ma-toolbar-btn:hover { background: rgba(233,61,130,0.2); border-color: #E93D82; }
.gjj-ma-toolbar-btn:active { transform: scale(0.95); }
.gjj-ma-toolbar-btn.active { background: rgba(233,61,130,0.35); border-color: #E93D82; color: #fff; }
.gjj-ma-toolbar-sep { width: 1px; height: 18px; background: #333; margin: 0 2px; flex-shrink: 0; }
.gjj-ma-select {
    background: rgba(10,10,15,0.9);
    border: 1px solid rgba(100,100,120,0.4);
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 10px;
    color: #e0e0e0;
    cursor: pointer;
    outline: none;
    max-width: 72px;
    height: 24px;
}
.gjj-ma-select:hover { border-color: rgba(150,150,170,0.6); }
.gjj-ma-select.az:focus { border-color: #E93D82; }
.gjj-ma-select.el:focus { border-color: #00FFD0; }
.gjj-ma-select.dist:focus { border-color: #FFB800; }
.gjj-ma-select option { background: #1a1a2e; color: #e0e0e0; }
.gjj-ma-status {
    font-size: 10px;
    color: #888;
    margin-left: auto;
    white-space: nowrap;
}
`;
        document.head.appendChild(style);
    }

    function readProps(node) {
        return (node.properties && node.properties[PROP_KEY]) || {};
    }

    function writeProps(node, patch) {
        if (!node.properties) node.properties = {};
        const existing = node.properties[PROP_KEY] || {};
        node.properties[PROP_KEY] = { ...existing, ...patch };
    }

    function getWidgetVal(node, name, def) {
        const w = node.widgets && node.widgets.find(w => w.name === name);
        return w ? Number(w.value) : def;
    }

    function setWidgetVal(node, name, val) {
        const w = node.widgets && node.widgets.find(w => w.name === name);
        if (w) w.value = val;
    }

    function hDirectionZh(angle) {
        const h = ((angle % 360) + 360) % 360;
        if (h < 22.5 || h >= 337.5) return "正面视角";
        if (h < 67.5) return "右前方视角";
        if (h < 112.5) return "右侧视角";
        if (h < 157.5) return "右后方视角";
        if (h < 202.5) return "背面视角";
        if (h < 247.5) return "左后方视角";
        if (h < 292.5) return "左侧视角";
        return "左前方视角";
    }

    function vDirectionZh(angle) {
        if (angle < -15) return "仰拍";
        if (angle < 15) return "平视";
        if (angle < 45) return "高角度";
        return "俯拍";
    }

    function distLabelZh(zoom) {
        if (zoom < 2) return "远景";
        if (zoom < 6) return "中景";
        return "特写";
    }

    function hDirectionEn(angle) {
        const h = ((angle % 360) + 360) % 360;
        if (h < 22.5 || h >= 337.5) return "front view";
        if (h < 67.5) return "front-right quarter view";
        if (h < 112.5) return "right side view";
        if (h < 157.5) return "back-right quarter view";
        if (h < 202.5) return "back view";
        if (h < 247.5) return "back-left quarter view";
        if (h < 292.5) return "left side view";
        return "front-left quarter view";
    }

    function vDirectionEn(angle) {
        if (angle < -15) return "low-angle shot";
        if (angle < 15) return "eye-level shot";
        if (angle < 45) return "elevated shot";
        return "high-angle shot";
    }

    function distLabelEn(zoom) {
        if (zoom < 2) return "wide shot";
        if (zoom < 6) return "medium shot";
        return "close-up";
    }

    function buildPrompt(az, el, dist) {
        const h = hDirectionEn(az);
        const v = vDirectionEn(el);
        const d = distLabelEn(dist);
        return `<sks> ${h} ${v} ${d}`;
    }

    function buildPromptDisplay(az, el, dist) {
        const hZh = hDirectionZh(az);
        const vZh = vDirectionZh(el);
        const dZh = distLabelZh(dist);
        const hEn = hDirectionEn(az);
        const vEn = vDirectionEn(el);
        const dEn = distLabelEn(dist);
        return `${hZh} ${vZh} ${dZh}  →  <sks> ${hEn} ${vEn} ${dEn}`;
    }

    class Camera3DWidget {
        constructor(container, node) {
            this.container = container;
            this.node = node;
            this.state = {
                azimuth: getWidgetVal(node, "horizontal_angle", 0),
                elevation: getWidgetVal(node, "vertical_angle", 0),
                distance: getWidgetVal(node, "zoom", 5),
            };
            this.liveAz = this.state.azimuth;
            this.liveEl = this.state.elevation;
            this.liveDist = this.state.distance;
            this.useCameraView = false;
            this._localImageUrl = null;
            this._upstreamImageUrl = null;
            this.isDragging = false;
            this.dragTarget = null;
            this.hoveredHandle = null;
            this.isOrbitDragging = false;
            this.orbitStartX = 0;
            this.orbitStartY = 0;
            this.orbitStartAz = 0;
            this.orbitStartEl = 0;
            this.animationId = null;
            this.time = 0;
            this.onStateChange = null;
            this.CENTER = { x: 0, y: 0.5, z: 0 };
            this.AZ_RADIUS = 1.8;
            this.EL_RADIUS = 1.4;
            this.EL_ARC_X = -0.8;
            this._initThree();
            this._bindEvents();
            this._animate();
        }

        _initThree() {
            const THREE = window.THREE;
            if (!THREE) {
                this.container.innerHTML = '<div style="color:#E93D82;padding:20px;text-align:center;font-size:13px;">⚠️ 未检测到 Three.js，3D预览不可用。<br>请安装 comfyui-qwenmultiangle 插件或加载 Three.js。</div>';
                return;
            }
            this.hasThree = true;
            const w = this.container.clientWidth || 300;
            const h = this.container.clientHeight || 300;

            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x0a0a0f);

            this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
            this.camera.position.set(4, 3.5, 4);
            this.camera.lookAt(0, 0.3, 0);

            this.previewCamera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
            this.activeCamera = this.camera;

            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setSize(w, h, false);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            this.container.appendChild(this.renderer.domElement);
            const canvas = this.renderer.domElement;
            canvas.style.position = "absolute";
            canvas.style.top = "0";
            canvas.style.left = "0";
            canvas.style.width = "100%";
            canvas.style.height = "100%";

            const ambient = new THREE.AmbientLight(0xffffff, 0.4);
            this.scene.add(ambient);
            const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
            mainLight.position.set(5, 10, 5);
            this.scene.add(mainLight);
            const fillLight = new THREE.DirectionalLight(0xE93D82, 0.3);
            fillLight.position.set(-5, 5, -5);
            this.scene.add(fillLight);

            this.gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
            this.gridHelper.position.y = -0.01;
            this.scene.add(this.gridHelper);

            this._createSubject();
            this._createCameraIndicator();
            this._createAzimuthRing();
            this._createElevationArc();
            this._createDistanceHandle();
            this._updateVisuals();
        }

        _createSubject() {
            const THREE = window.THREE;
            const cardGeo = new THREE.BoxGeometry(1.2, 1.2, 0.02);
            const gridTex = this._createGridTexture();
            const frontMat = new THREE.MeshBasicMaterial({ color: 0x3a3a4a });
            const backMat = new THREE.MeshBasicMaterial({ map: gridTex });
            const edgeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a2a });
            this.imagePlane = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, backMat]);
            this.imagePlane.position.set(0, 0.5, 0);
            this.scene.add(this.imagePlane);
            this.planeMat = frontMat;

            const frameGeo = new THREE.EdgesGeometry(cardGeo);
            const frameMat = new THREE.LineBasicMaterial({ color: 0xE93D82 });
            this.imageFrame = new THREE.LineSegments(frameGeo, frameMat);
            this.imageFrame.position.set(0, 0.5, 0);
            this.scene.add(this.imageFrame);

            const glowGeo = new THREE.RingGeometry(0.55, 0.58, 64);
            const glowMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
            this.glowRing = new THREE.Mesh(glowGeo, glowMat);
            this.glowRing.position.set(0, 0.01, 0);
            this.glowRing.rotation.x = -Math.PI / 2;
            this.scene.add(this.glowRing);
        }

        _createGridTexture() {
            const THREE = window.THREE;
            const c = document.createElement("canvas");
            const s = 256;
            c.width = s; c.height = s;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#1a1a2a";
            ctx.fillRect(0, 0, s, s);
            ctx.strokeStyle = "#2a2a3a";
            ctx.lineWidth = 1;
            for (let i = 0; i <= s; i += 16) {
                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
            }
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(4, 4);
            return tex;
        }

        _createCameraIndicator() {
            const THREE = window.THREE;
            const geo = new THREE.ConeGeometry(0.15, 0.4, 4);
            const mat = new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.2 });
            this.cameraIndicator = new THREE.Mesh(geo, mat);
            this.scene.add(this.cameraIndicator);

            const glowGeo = new THREE.SphereGeometry(0.08, 16, 16);
            const glowMat = new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 });
            this.camGlow = new THREE.Mesh(glowGeo, glowMat);
            this.scene.add(this.camGlow);
        }

        _createAzimuthRing() {
            const THREE = window.THREE;
            const ringGeo = new THREE.TorusGeometry(this.AZ_RADIUS, 0.04, 16, 100);
            const ringMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.7 });
            this.azimuthRing = new THREE.Mesh(ringGeo, ringMat);
            this.azimuthRing.rotation.x = Math.PI / 2;
            this.azimuthRing.position.y = 0.02;
            this.scene.add(this.azimuthRing);

            const hGeo = new THREE.SphereGeometry(0.16, 32, 32);
            const hMat = new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
            this.azimuthHandle = new THREE.Mesh(hGeo, hMat);
            this.scene.add(this.azimuthHandle);

            const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
            const gMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.2 });
            this.azGlow = new THREE.Mesh(gGeo, gMat);
            this.scene.add(this.azGlow);
        }

        _createElevationArc() {
            const THREE = window.THREE;
            const pts = [];
            for (let i = 0; i <= 32; i++) {
                const a = (-30 + (90 * i / 32)) * Math.PI / 180;
                pts.push(new THREE.Vector3(this.EL_ARC_X, this.EL_RADIUS * Math.sin(a) + 0.5, this.EL_RADIUS * Math.cos(a)));
            }
            const curve = new THREE.CatmullRomCurve3(pts);
            const arcGeo = new THREE.TubeGeometry(curve, 32, 0.04, 8, false);
            const arcMat = new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.8 });
            this.elevationArc = new THREE.Mesh(arcGeo, arcMat);
            this.scene.add(this.elevationArc);

            const hGeo = new THREE.SphereGeometry(0.16, 32, 32);
            const hMat = new THREE.MeshStandardMaterial({ color: 0x00FFD0, emissive: 0x00FFD0, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
            this.elevationHandle = new THREE.Mesh(hGeo, hMat);
            this.scene.add(this.elevationHandle);

            const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
            const gMat = new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.2 });
            this.elGlow = new THREE.Mesh(gGeo, gMat);
            this.scene.add(this.elGlow);
        }

        _createDistanceHandle() {
            const THREE = window.THREE;
            const hGeo = new THREE.SphereGeometry(0.15, 32, 32);
            const hMat = new THREE.MeshStandardMaterial({ color: 0xFFB800, emissive: 0xFFB800, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.3 });
            this.distanceHandle = new THREE.Mesh(hGeo, hMat);
            this.scene.add(this.distanceHandle);

            const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
            const gMat = new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.25 });
            this.distGlow = new THREE.Mesh(gGeo, gMat);
            this.scene.add(this.distGlow);

            this.distanceTube = null;
        }

        _updateDistanceLine(start, end) {
            const THREE = window.THREE;
            if (this.distanceTube) {
                this.scene.remove(this.distanceTube);
                this.distanceTube.geometry.dispose();
                this.distanceTube.material.dispose();
            }
            const path = new THREE.LineCurve3(start, end);
            const geo = new THREE.TubeGeometry(path, 1, 0.025, 8, false);
            const mat = new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.8 });
            this.distanceTube = new THREE.Mesh(geo, mat);
            this.scene.add(this.distanceTube);
        }

        _updateVisuals() {
            if (!this.hasThree) return;
            const THREE = window.THREE;
            const azRad = (this.liveAz * Math.PI) / 180;
            const elRad = (this.liveEl * Math.PI) / 180;
            const vDist = 2.6 - (this.liveDist / 10) * 2.0;
            const cx = vDist * Math.sin(azRad) * Math.cos(elRad);
            const cy = 0.5 + vDist * Math.sin(elRad);
            const cz = vDist * Math.cos(azRad) * Math.cos(elRad);

            this.cameraIndicator.position.set(cx, cy, cz);
            this.cameraIndicator.lookAt(0, 0.5, 0);
            this.cameraIndicator.rotateX(Math.PI / 2);
            this.camGlow.position.copy(this.cameraIndicator.position);

            const ax = this.AZ_RADIUS * Math.sin(azRad);
            const az = this.AZ_RADIUS * Math.cos(azRad);
            this.azimuthHandle.position.set(ax, 0.16, az);
            this.azGlow.position.copy(this.azimuthHandle.position);

            const ey = 0.5 + this.EL_RADIUS * Math.sin(elRad);
            const ez = this.EL_RADIUS * Math.cos(elRad);
            this.elevationHandle.position.set(this.EL_ARC_X, ey, ez);
            this.elGlow.position.copy(this.elevationHandle.position);

            const dt = 0.15 + ((10 - this.liveDist) / 10) * 0.7;
            const center3 = new THREE.Vector3(0, 0.5, 0);
            const camPos = new THREE.Vector3(cx, cy, cz);
            this.distanceHandle.position.lerpVectors(center3, camPos, dt);
            this.distGlow.position.copy(this.distanceHandle.position);

            this._updateDistanceLine(center3.clone(), camPos.clone());

            this.previewCamera.position.copy(this.cameraIndicator.position);
            this.previewCamera.lookAt(0, 0.5, 0);

            this.glowRing.rotation.z += 0.005;
        }

        _bindEvents() {
            if (!this.hasThree) return;
            const c = this.renderer.domElement;
            c.addEventListener("mousedown", (e) => this._onDown(e));
            c.addEventListener("mousemove", (e) => this._onMove(e));
            c.addEventListener("mouseup", () => this._onUp());
            c.addEventListener("mouseleave", () => this._onUp());
            c.addEventListener("touchstart", (e) => { e.preventDefault(); this._onDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }); }, { passive: false });
            c.addEventListener("touchmove", (e) => { e.preventDefault(); this._onMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }); }, { passive: false });
            c.addEventListener("touchend", () => this._onUp());
            c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

            const ro = new ResizeObserver(() => this._onResize());
            ro.observe(this.container);
        }

        _getMouse(e) {
            const rect = this.renderer.domElement.getBoundingClientRect();
            this._mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this._my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        }

        _setScale(handle, glow, s) {
            handle.scale.setScalar(s);
            if (glow) glow.scale.setScalar(s);
        }

        _onDown(e) {
            this._getMouse(e);
            const THREE = window.THREE;
            if (this.useCameraView) {
                this.isOrbitDragging = true;
                this.orbitStartX = e.clientX;
                this.orbitStartY = e.clientY;
                this.orbitStartAz = this.liveAz;
                this.orbitStartEl = this.liveEl;
                this.renderer.domElement.style.cursor = "grabbing";
                return;
            }
            const ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2(this._mx, this._my), this.camera);
            const handles = [
                { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
                { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
                { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
            ];
            for (const h of handles) {
                if (ray.intersectObject(h.mesh).length > 0) {
                    this.isDragging = true;
                    this.dragTarget = h.name;
                    this._setScale(h.mesh, h.glow, 1.3);
                    this.renderer.domElement.style.cursor = "grabbing";
                    return;
                }
            }
        }

        _onMove(e) {
            this._getMouse(e);
            const THREE = window.THREE;
            if (this.useCameraView && this.isOrbitDragging) {
                const dx = e.clientX - this.orbitStartX;
                const dy = e.clientY - this.orbitStartY;
                let newAz = this.orbitStartAz - dx * 0.5;
                while (newAz < 0) newAz += 360;
                while (newAz >= 360) newAz -= 360;
                this.liveAz = newAz;
                this.state.azimuth = Math.round(this.liveAz);
                let newEl = this.orbitStartEl + dy * 0.5;
                newEl = Math.max(-30, Math.min(60, newEl));
                this.liveEl = newEl;
                this.state.elevation = Math.round(this.liveEl);
                this._updateVisuals();
                this._notify();
                return;
            }
            const ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2(this._mx, this._my), this.camera);
            if (!this.isDragging) {
                const handles = [
                    { mesh: this.azimuthHandle, glow: this.azGlow, name: "azimuth" },
                    { mesh: this.elevationHandle, glow: this.elGlow, name: "elevation" },
                    { mesh: this.distanceHandle, glow: this.distGlow, name: "distance" },
                ];
                let found = null;
                for (const h of handles) {
                    if (ray.intersectObject(h.mesh).length > 0) { found = h; break; }
                }
                if (this.hoveredHandle && this.hoveredHandle !== found) {
                    this._setScale(this.hoveredHandle.mesh, this.hoveredHandle.glow, 1.0);
                }
                if (found) {
                    this._setScale(found.mesh, found.glow, 1.15);
                    this.renderer.domElement.style.cursor = "grab";
                    this.hoveredHandle = found;
                } else {
                    this.renderer.domElement.style.cursor = "default";
                    this.hoveredHandle = null;
                }
                return;
            }
            const plane = new THREE.Plane();
            const intersect = new THREE.Vector3();
            if (this.dragTarget === "azimuth") {
                plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
                if (ray.ray.intersectPlane(plane, intersect)) {
                    let angle = Math.atan2(intersect.x, intersect.z) * (180 / Math.PI);
                    if (angle < 0) angle += 360;
                    this.liveAz = Math.max(0, Math.min(360, angle));
                    this.state.azimuth = Math.round(this.liveAz);
                    this._updateVisuals();
                    this._notify();
                }
            } else if (this.dragTarget === "elevation") {
                const elevPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -this.EL_ARC_X);
                if (ray.ray.intersectPlane(elevPlane, intersect)) {
                    const ry = intersect.y - 0.5;
                    const rz = intersect.z;
                    let a = Math.atan2(ry, rz) * (180 / Math.PI);
                    a = Math.max(-30, Math.min(60, a));
                    this.liveEl = a;
                    this.state.elevation = Math.round(this.liveEl);
                    this._updateVisuals();
                    this._notify();
                }
            } else if (this.dragTarget === "distance") {
                const nd = 5 - this._my * 5;
                this.liveDist = Math.max(0, Math.min(10, nd));
                this.state.distance = Math.round(this.liveDist * 10) / 10;
                this._updateVisuals();
                this._notify();
            }
        }

        _onUp() {
            if (this.isOrbitDragging) {
                this.isOrbitDragging = false;
                this.renderer.domElement.style.cursor = this.useCameraView ? "grab" : "default";
                return;
            }
            if (this.isDragging) {
                const handles = [
                    { mesh: this.azimuthHandle, glow: this.azGlow },
                    { mesh: this.elevationHandle, glow: this.elGlow },
                    { mesh: this.distanceHandle, glow: this.distGlow },
                ];
                handles.forEach(h => this._setScale(h.mesh, h.glow, 1.0));
            }
            this.isDragging = false;
            this.dragTarget = null;
            this.renderer.domElement.style.cursor = "default";
        }

        _onWheel(e) {
            if (!this.useCameraView) return;
            e.preventDefault();
            const nd = this.liveDist - e.deltaY * 0.01;
            this.liveDist = Math.max(0, Math.min(10, nd));
            this.state.distance = Math.round(this.liveDist * 10) / 10;
            this._updateVisuals();
            this._notify();
        }

        _onResize() {
            if (!this.hasThree) return;
            const w = this.container.clientWidth;
            const h = this.container.clientHeight;
            if (w === 0 || h === 0) return;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.previewCamera.aspect = w / h;
            this.previewCamera.updateProjectionMatrix();
            this.renderer.setSize(w, h, false);
        }

        _animate() {
            this.animationId = requestAnimationFrame(() => this._animate());
            if (!this.hasThree) return;
            this.time += 0.01;
            const pulse = 1 + Math.sin(this.time * 2) * 0.03;
            this.camGlow.scale.setScalar(pulse);
            this.glowRing.rotation.z += 0.003;
            this.renderer.render(this.scene, this.activeCamera);
        }

        _notify() {
            setWidgetVal(this.node, "horizontal_angle", this.state.azimuth);
            setWidgetVal(this.node, "vertical_angle", this.state.elevation);
            setWidgetVal(this.node, "zoom", this.state.distance);
            writeProps(this.node, {
                azimuth: this.state.azimuth,
                elevation: this.state.elevation,
                distance: this.state.distance,
            });
            if (this.onStateChange) this.onStateChange(this.state);
            app.graph && app.graph.setDirtyCanvas(true, true);
        }

        setState(s) {
            if (s.azimuth !== undefined) { this.state.azimuth = s.azimuth; this.liveAz = s.azimuth; }
            if (s.elevation !== undefined) { this.state.elevation = s.elevation; this.liveEl = s.elevation; }
            if (s.distance !== undefined) { this.state.distance = s.distance; this.liveDist = s.distance; }
            this._updateVisuals();
        }

        setCameraView(enabled) {
            this.useCameraView = enabled;
            this.isOrbitDragging = false;
            if (!this.hasThree) return;
            if (enabled) {
                this.activeCamera = this.previewCamera;
                this.azimuthRing.visible = false;
                this.azimuthHandle.visible = false;
                this.azGlow.visible = false;
                this.elevationArc.visible = false;
                this.elevationHandle.visible = false;
                this.elGlow.visible = false;
                this.distanceHandle.visible = false;
                this.distGlow.visible = false;
                if (this.distanceTube) this.distanceTube.visible = false;
                this.cameraIndicator.visible = false;
                this.camGlow.visible = false;
                this.glowRing.visible = false;
                this.gridHelper.visible = false;
                this.imageFrame.visible = false;
                this.renderer.domElement.style.cursor = "grab";
            } else {
                this.activeCamera = this.camera;
                this.azimuthRing.visible = true;
                this.azimuthHandle.visible = true;
                this.azGlow.visible = true;
                this.elevationArc.visible = true;
                this.elevationHandle.visible = true;
                this.elGlow.visible = true;
                this.distanceHandle.visible = true;
                this.distGlow.visible = true;
                if (this.distanceTube) this.distanceTube.visible = true;
                this.cameraIndicator.visible = true;
                this.camGlow.visible = true;
                this.glowRing.visible = true;
                this.gridHelper.visible = true;
                this.imageFrame.visible = true;
                this.renderer.domElement.style.cursor = "default";
            }
        }

        updateImage(url, source = "upstream") {
            if (!this.hasThree) return;
            const THREE = window.THREE;

            if (source === "local") {
                this._localImageUrl = url || null;
            } else if (source === "upstream") {
                this._upstreamImageUrl = url || null;
            }

            const displayUrl = this._upstreamImageUrl || this._localImageUrl;

            if (displayUrl) {
                const img = new Image();
                if (!displayUrl.startsWith("data:")) img.crossOrigin = "anonymous";
                img.onload = () => {
                    const tex = new THREE.Texture(img);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.needsUpdate = true;
                    this.planeMat.map = tex;
                    this.planeMat.color.set(0xffffff);
                    this.planeMat.needsUpdate = true;
                    const ar = img.width / img.height;
                    const maxH = 2.0;
                    const maxW = 2.0;
                    let sx, sy;
                    if (ar >= 1) {
                        sx = Math.min(maxW, maxH * ar);
                        sy = sx / ar;
                    } else {
                        sy = Math.min(maxH, maxW / ar);
                        sx = sy * ar;
                    }
                    this.imagePlane.scale.set(sx, sy, 1);
                    this.imageFrame.scale.set(sx, sy, 1);
                };
                img.onerror = () => {
                    this.planeMat.map = null;
                    this.planeMat.color.set(0xE93D82);
                    this.planeMat.needsUpdate = true;
                };
                img.src = displayUrl;
            } else {
                this.planeMat.map = null;
                this.planeMat.color.set(0x3a3a4a);
                this.planeMat.needsUpdate = true;
                this.imagePlane.scale.set(1, 1, 1);
                this.imageFrame.scale.set(1, 1, 1);
            }
        }

        dispose() {
            if (this.animationId !== null) {
                try { window.cancelAnimationFrame(this.animationId); } catch {}
                this.animationId = null;
            }
            if (this.hasThree) {
                try { this.renderer.dispose(); } catch {}
                try { this.scene.clear(); } catch {}
            }
        }
    }

    function createDOMWidget(node) {
        injectStyles();

        const wrapper = document.createElement("div");
        wrapper.className = "gjj-ma-container";

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "gjj-ma-canvas-wrap";
        wrapper.appendChild(canvasWrap);

        const promptBar = document.createElement("div");
        promptBar.className = "gjj-ma-prompt-bar";
        canvasWrap.appendChild(promptBar);

        const infoBar = document.createElement("div");
        infoBar.className = "gjj-ma-info-bar";
        const infoRow = document.createElement("div");
        infoRow.className = "gjj-ma-info-row";
        infoBar.appendChild(infoRow);
        canvasWrap.appendChild(infoBar);

        const toolbar = document.createElement("div");
        toolbar.className = "gjj-ma-toolbar";
        wrapper.appendChild(toolbar);

        const cam3d = new Camera3DWidget(canvasWrap, node);

        function updatePromptBar() {
            const az = cam3d.state.azimuth;
            const el = cam3d.state.elevation;
            const d = cam3d.state.distance;
            promptBar.textContent = buildPromptDisplay(az, el, d);
        }

        function updateInfoBar() {
            const az = cam3d.state.azimuth;
            const el = cam3d.state.elevation;
            const d = cam3d.state.distance;
            infoRow.innerHTML = `
                <div class="gjj-ma-param"><div class="gjj-ma-param-label">水平</div><div class="gjj-ma-param-value az">${az}°</div></div>
                <div class="gjj-ma-param"><div class="gjj-ma-param-label">垂直</div><div class="gjj-ma-param-value el">${el}°</div></div>
                <div class="gjj-ma-param"><div class="gjj-ma-param-label">距离</div><div class="gjj-ma-param-value dist">${d.toFixed(1)}</div></div>
            `;
        }

        cam3d.onStateChange = () => {
            updatePromptBar();
            updateInfoBar();
        };

        const btnFullscreen = document.createElement("button");
        btnFullscreen.className = "gjj-ma-toolbar-btn";
        btnFullscreen.textContent = "🔍";
        btnFullscreen.title = "全屏预览3D场景";
        btnFullscreen.addEventListener("click", () => {
            const canvas = canvasWrap.querySelector("canvas");
            if (canvas && canvas.requestFullscreen) {
                canvas.requestFullscreen();
            }
        });
        toolbar.appendChild(btnFullscreen);

        const btnOpenFile = document.createElement("button");
        btnOpenFile.className = "gjj-ma-toolbar-btn";
        btnOpenFile.textContent = "📁";
        btnOpenFile.title = "打开本地图片到相机视角预览";
        btnOpenFile.addEventListener("click", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.style.display = "none";
            document.body.appendChild(input);
            input.addEventListener("change", (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    cam3d.updateImage(dataUrl, "local");
                    if (status) status.textContent = "已加载本地图片";
                };
                reader.readAsDataURL(file);
                document.body.removeChild(input);
            });
            input.click();
        });
        toolbar.appendChild(btnOpenFile);

        const btnRefreshUpstream = document.createElement("button");
        btnRefreshUpstream.className = "gjj-ma-toolbar-btn";
        btnRefreshUpstream.textContent = "🔄";
        btnRefreshUpstream.title = "刷新上游图片到相机视角预览";
        btnRefreshUpstream.addEventListener("click", () => {
            const imageInput = node.inputs && node.inputs.find(inp => inp.name === "image");
            if (!imageInput || !imageInput.link) {
                if (status) status.textContent = "未连接上游图片";
                return;
            }
            cam3d._pendingUpstreamRefresh = true;
            if (status) status.textContent = "正在刷新上游图片...";
            app.queuePrompt(0, 1);
        });
        toolbar.appendChild(btnRefreshUpstream);

        const btnReset = document.createElement("button");
        btnReset.className = "gjj-ma-toolbar-btn";
        btnReset.textContent = "↺";
        btnReset.title = "重置为默认角度";
        btnReset.addEventListener("click", () => {
            cam3d.setState({ azimuth: 0, elevation: 0, distance: 5 });
            setWidgetVal(node, "horizontal_angle", 0);
            setWidgetVal(node, "vertical_angle", 0);
            setWidgetVal(node, "zoom", 5);
            writeProps(node, { azimuth: 0, elevation: 0, distance: 5 });
            updatePromptBar();
            updateInfoBar();
            app.graph && app.graph.setDirtyCanvas(true, true);
        });
        toolbar.appendChild(btnReset);

        toolbar.appendChild(createSep());

        const azLabel = document.createElement("span");
        azLabel.style.cssText = "font-size:9px;color:#E93D82;margin-right:2px;";
        azLabel.textContent = "水平";
        toolbar.appendChild(azLabel);

        const azSelect = document.createElement("select");
        azSelect.className = "gjj-ma-select az";
        AZIMUTH_PRESETS.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.value;
            opt.textContent = p.label;
            azSelect.appendChild(opt);
        });
        azSelect.addEventListener("change", () => {
            const v = parseInt(azSelect.value);
            cam3d.setState({ azimuth: v });
            setWidgetVal(node, "horizontal_angle", v);
            writeProps(node, { azimuth: v });
            updatePromptBar();
            updateInfoBar();
            app.graph && app.graph.setDirtyCanvas(true, true);
        });
        toolbar.appendChild(azSelect);

        toolbar.appendChild(createSep());

        const elLabel = document.createElement("span");
        elLabel.style.cssText = "font-size:9px;color:#00FFD0;margin-right:2px;";
        elLabel.textContent = "垂直";
        toolbar.appendChild(elLabel);

        const elSelect = document.createElement("select");
        elSelect.className = "gjj-ma-select el";
        ELEVATION_PRESETS.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.value;
            opt.textContent = p.label;
            elSelect.appendChild(opt);
        });
        elSelect.addEventListener("change", () => {
            const v = parseInt(elSelect.value);
            cam3d.setState({ elevation: v });
            setWidgetVal(node, "vertical_angle", v);
            writeProps(node, { elevation: v });
            updatePromptBar();
            updateInfoBar();
            app.graph && app.graph.setDirtyCanvas(true, true);
        });
        toolbar.appendChild(elSelect);

        toolbar.appendChild(createSep());

        const distLabel = document.createElement("span");
        distLabel.style.cssText = "font-size:9px;color:#FFB800;margin-right:2px;";
        distLabel.textContent = "距离";
        toolbar.appendChild(distLabel);

        const distSelect = document.createElement("select");
        distSelect.className = "gjj-ma-select dist";
        DISTANCE_PRESETS.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.value;
            opt.textContent = p.label;
            distSelect.appendChild(opt);
        });
        distSelect.addEventListener("change", () => {
            const v = parseFloat(distSelect.value);
            cam3d.setState({ distance: v });
            setWidgetVal(node, "zoom", v);
            writeProps(node, { distance: v });
            updatePromptBar();
            updateInfoBar();
            app.graph && app.graph.setDirtyCanvas(true, true);
        });
        toolbar.appendChild(distSelect);

        toolbar.appendChild(createSep());

        const btnCameraView = document.createElement("button");
        btnCameraView.className = "gjj-ma-toolbar-btn";
        btnCameraView.textContent = "🎥";
        btnCameraView.title = "切换相机视角";
        btnCameraView.addEventListener("click", () => {
            const cur = node.properties && node.properties["camera_view"];
            const next = !cur;
            node.properties = node.properties || {};
            node.properties["camera_view"] = next;
            writeProps(node, { cameraView: next });
            btnCameraView.classList.toggle("active", next);
            cam3d.setCameraView(next);
        });
        toolbar.appendChild(btnCameraView);

        const status = document.createElement("span");
        status.className = "gjj-ma-status";
        status.textContent = "就绪";
        toolbar.appendChild(status);
        cam3d._statusEl = status;

        updatePromptBar();
        updateInfoBar();

        const widget = node.addDOMWidget("camera_preview", "gjj-multiangle-camera", wrapper, {
            getMinHeight: () => 420,
            hideOnZoom: false,
            serialize: false,
        });

        widget._cam3d = cam3d;
        widget._updatePromptBar = updatePromptBar;
        widget._updateInfoBar = updateInfoBar;

        const origOnRemove = widget.onRemove;
        widget.onRemove = () => {
            try { origOnRemove && origOnRemove.call(widget); } catch(e) {}
            try { cam3d.dispose(); } catch(e) {}
        };

        return widget;
    }

    function createSep() {
        const sep = document.createElement("div");
        sep.className = "gjj-ma-toolbar-sep";
        return sep;
    }

    function loadThreeJS() {
        if (window.THREE) return Promise.resolve(true);
        if (window.__THREE__) {
            console.warn("[GJJ][多角度相机] 检测到 ComfyUI 已加载 Three.js 模块但未暴露 window.THREE；为避免重复导入，3D 预览已降级。");
            return Promise.resolve(false);
        }
        if (threeLoadPromise) return threeLoadPromise;

        threeLoadPromise = new Promise((resolve) => {
            if (window.THREE) { resolve(true); return; }
            if (window.__THREE__) { resolve(false); return; }

            const existingGjjScript = document.querySelector(`script[src="${THREE_SCRIPT_URL}"]`);
            if (existingGjjScript) {
                const check = setInterval(() => {
                    if (window.THREE) { clearInterval(check); resolve(true); }
                }, 100);
                setTimeout(() => { clearInterval(check); resolve(!!window.THREE); }, 10000);
                return;
            }

            const existingThreeScript = document.querySelector('script[src*="three"]');
            if (existingThreeScript && !window.THREE) {
                console.warn("[GJJ][多角度相机] 检测到页面已有 Three.js 脚本，但未暴露 window.THREE；为避免重复导入，跳过 GJJ 内置 Three.js。");
                resolve(false);
                return;
            }

            const s = document.createElement("script");
            s.src = THREE_SCRIPT_URL;
            s.dataset.gjjThree = "true";
            s.onload = () => resolve(!!window.THREE);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });

        return threeLoadPromise;
    }

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;

            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                origCreated && origCreated.call(this);

                this.properties = this.properties || {};
                const stored = readProps(this);
                if (stored.azimuth !== undefined) {
                    setWidgetVal(this, "horizontal_angle", stored.azimuth);
                }
                if (stored.elevation !== undefined) {
                    setWidgetVal(this, "vertical_angle", stored.elevation);
                }
                if (stored.distance !== undefined) {
                    setWidgetVal(this, "zoom", stored.distance);
                }
                if (stored.cameraView !== undefined) {
                    this.properties["camera_view"] = stored.cameraView;
                }

                for (let i = this.widgets.length - 1; i >= 0; i--) {
                    const w = this.widgets[i];
                    if (BOOLEAN_NAMES.includes(w.name)) {
                        this.widgets.splice(i, 1);
                    }
                }

                loadThreeJS().then(() => {
                    createDOMWidget(this);
                    const sz = this.size;
                    this.setSize([Math.max(sz[0], 350), Math.max(sz[1], 520)]);
                });
            };

            const origOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output) {
                origOnExecuted && origOnExecuted.call(this, output);
                try {
                    const camWidget = this.widgets && this.widgets.find(w => w.name === "camera_preview");
                    if (!camWidget || !camWidget._cam3d) return;
                    const images = output && output.preview_images;
                    if (!images || images.length === 0) {
                        if (camWidget._cam3d._pendingUpstreamRefresh) {
                            camWidget._cam3d._pendingUpstreamRefresh = false;
                            if (camWidget._statusEl) camWidget._statusEl.textContent = "上游无图片输出";
                        }
                        camWidget._cam3d.updateImage(null, "upstream");
                        return;
                    }
                    const img = images[0];
                    const params = new URLSearchParams({
                        filename: img.filename,
                        subfolder: img.subfolder || "",
                        type: img.type || "temp",
                    });
                    const url = api.apiURL(`/view?${params.toString()}`);
                    camWidget._cam3d.updateImage(url, "upstream");
                    if (camWidget._cam3d._pendingUpstreamRefresh) {
                        camWidget._cam3d._pendingUpstreamRefresh = false;
                        if (camWidget._statusEl) camWidget._statusEl.textContent = "已刷新上游图片";
                    }
                } catch (e) {
                    console.warn("[GJJ][多角度相机] 处理执行结果失败:", e);
                }
            };

            const origOnPropChanged = nodeType.prototype.onPropertyChanged;
            nodeType.prototype.onPropertyChanged = function (key, value) {
                origOnPropChanged && origOnPropChanged.call(this, key, value);
                if (key !== PROP_KEY) return;
                if (!value || typeof value !== "object") return;
                const camWidget = this.widgets && this.widgets.find(w => w.name === "camera_preview");
                if (!camWidget || !camWidget._cam3d) return;
                camWidget._cam3d.setState({
                    azimuth: value.azimuth,
                    elevation: value.elevation,
                    distance: value.distance,
                });
                if (value.cameraView !== undefined) {
                    camWidget._cam3d.setCameraView(Boolean(value.cameraView));
                }
                camWidget._updatePromptBar && camWidget._updatePromptBar();
                camWidget._updateInfoBar && camWidget._updateInfoBar();
            };
        },
    });
})();

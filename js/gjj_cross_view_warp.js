import { app } from "../../scripts/app.js";

const 节点键 = "GJJ_CrossViewWarp";
const 画布高度 = 304;
const 球体最大高度 = 700;
const 节点最小高度 = 720;
const 吸附角度 = 5;

let _缓存高度 = 画布高度;
let _缓存宽度 = -1;

function 球体高度(node) {
    const width = Math.round(node.size?.[0] ?? 360);
    if (width === _缓存宽度) return _缓存高度;
    const target = Math.max(画布高度, Math.min(球体最大高度, Math.floor(width * 0.85)));
    _缓存宽度 = width;
    _缓存高度 = target;
    return target;
}

function 获取控件(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function 角转弧度(value) {
    return Number(value) * Math.PI / 180;
}

function 弧度转角(value) {
    return value * 180 / Math.PI;
}

function 距离比例(value) {
    const distance = Number(value);
    return distance <= 1 ? 0.45 + 0.55 * distance : 1 + 0.25 * (distance - 1);
}

function 角度归一化(value) {
    return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

function 解析关键帧(raw) {
    try {
        const data = JSON.parse(String(raw || "").trim() || "[]");
        if (!Array.isArray(data)) return [];
        return data
            .map((item) => ({
                f: Math.round(Number(item?.f)),
                az: Number(item?.az),
                el: Number(item?.el),
                dist: Number(item?.dist),
            }))
            .filter((item) => [item.f, item.az, item.el, item.dist].every(Number.isFinite))
            .sort((a, b) => a.f - b.f);
    } catch (_) {
        return [];
    }
}

function 解开角度(values) {
    const result = [Number(values[0])];
    for (let index = 1; index < values.length; index++) {
        result.push(result[index - 1] + 角度归一化(Number(values[index]) - result[index - 1]));
    }
    return result;
}

function 插值数值(values, segment, amount, smooth) {
    const p1 = values[segment];
    const p2 = values[segment + 1];
    if (!smooth || values.length < 3) return p1 + (p2 - p1) * amount;
    const p0 = segment > 0 ? values[segment - 1] : p1 + (p1 - p2);
    const p3 = segment + 2 < values.length ? values[segment + 2] : p2 + (p2 - p1);
    return 0.5 * (
        2 * p1 + (-p0 + p2) * amount
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * amount * amount
        + (-p0 + 3 * p1 - 3 * p2 + p3) * amount * amount * amount
    );
}

function 球面点(水平角, 垂直角) {
    const a = 角转弧度(水平角);
    const e = 角转弧度(垂直角);
    return [Math.cos(e) * Math.sin(a), -Math.cos(e) * Math.cos(a), Math.sin(e)];
}

class 观察视角 {
    constructor() {
        this.水平 = 0.24;
        this.俯仰 = 0.20;
    }

    旋转([x, y, z]) {
        const cy = Math.cos(this.水平);
        const sy = Math.sin(this.水平);
        const ct = Math.cos(this.俯仰);
        const st = Math.sin(this.俯仰);
        const xr = x * cy + y * sy;
        const yr = -x * sy + y * cy;
        return [xr, yr * ct - z * st, yr * st + z * ct];
    }

    反投影(px, py, radius) {
        const xr = px / radius;
        const zv = -py / radius;
        const squared = xr * xr + zv * zv;
        if (squared > 1) return null;
        const yv = -Math.sqrt(1 - squared);
        const ct = Math.cos(this.俯仰);
        const st = Math.sin(this.俯仰);
        const yr = yv * ct + zv * st;
        const z = -yv * st + zv * ct;
        const cy = Math.cos(this.水平);
        const sy = Math.sin(this.水平);
        const x = xr * cy - yr * sy;
        const y = xr * sy + yr * cy;
        return [
            弧度转角(Math.atan2(x, -y)),
            弧度转角(Math.asin(Math.max(-1, Math.min(1, z)))),
        ];
    }
}

function 区域颜色(水平角, 垂直角) {
    const 检查 = ([横, 上, 下]) => {
        const x = 水平角 / 横;
        const y = 垂直角 / (垂直角 >= 0 ? 上 : 下);
        return x * x + y * y <= 1;
    };
    if (检查([45, 30, 15])) return [80, 200, 120];
    if (检查([65, 40, 25])) return [230, 200, 90];
    return null;
}

function 绘制球体(ctx, view, cx, cy, radius) {
    const 投影 = (az, el) => {
        const [x, front, z] = view.旋转(球面点(az, el));
        return [cx + radius * x, cy - radius * z, front];
    };

    ctx.fillStyle = "rgba(70,74,86,0.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    for (let az = -70; az < 70; az += 15) {
        for (let el = -30; el < 45; el += 15) {
            const color = 区域颜色(az + 7.5, el + 7.5);
            if (!color) continue;
            const points = [
                投影(az, el), 投影(az + 15, el),
                投影(az + 15, el + 15), 投影(az, el + 15),
            ];
            if (points.some((point) => point[2] >= 0)) continue;
            ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},0.13)`;
            ctx.beginPath();
            ctx.moveTo(points[0][0], points[0][1]);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
            ctx.closePath();
            ctx.fill();
        }
    }

    const 绘制环 = (points) => {
        for (let i = 0; i < points.length - 1; i++) {
            const first = points[i];
            const second = points[i + 1];
            ctx.strokeStyle = first[2] < 0 && second[2] < 0
                ? "rgba(200,204,216,0.5)" : "rgba(120,124,138,0.15)";
            ctx.beginPath();
            ctx.moveTo(first[0], first[1]);
            ctx.lineTo(second[0], second[1]);
            ctx.stroke();
        }
    };
    ctx.lineWidth = 1.5;
    const equator = [];
    for (let az = -180; az <= 180; az += 8) equator.push(投影(az, 0));
    绘制环(equator);
    const meridian = [];
    for (let el = -90; el <= 90; el += 8) meridian.push(投影(0, el));
    绘制环(meridian);
    ctx.strokeStyle = "rgba(190,190,205,0.55)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
}

class 轨道球编辑器 {
    constructor(node, canvas) {
        this.node = node;
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.view = new 观察视角();
        this.拖动 = null;
        this.上次位置 = null;
        this.相机位置 = null;
        this.关键帧 = [];
        this.关键帧位置 = [];
        this.拖动关键帧 = -1;
        this.渲染键 = "";

        canvas.addEventListener("pointerdown", (event) => this.按下(event));
        canvas.addEventListener("pointermove", (event) => this.移动(event));
        canvas.addEventListener("pointerup", (event) => this.抬起(event));
        canvas.addEventListener("pointercancel", (event) => this.抬起(event));
        canvas.addEventListener("wheel", (event) => this.滚轮(event), { passive: false });
        canvas.addEventListener("contextmenu", (event) => this.右键(event));
        canvas.addEventListener("dblclick", () => {
            this.view.水平 = 0.24;
            this.view.俯仰 = 0.20;
            this.绘制(true);
        });

        this.循环 = () => {
            if (!canvas.isConnected) return;
            this.绘制(false);
            requestAnimationFrame(this.循环);
        };
        requestAnimationFrame(this.循环);
    }

    坐标(event) {
        const rect = this.canvas.getBoundingClientRect();
        return [
            (event.clientX - rect.left) * this.canvas.width / rect.width,
            (event.clientY - rect.top) * this.canvas.height / rect.height,
        ];
    }

    几何() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const size = Math.min(width - 16, height - 12);
        return { cx: width / 2, cy: height / 2, radius: (size / 2 - 4) * 0.62 };
    }

    按下(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.canvas.setPointerCapture?.(event.pointerId);
        const [x, y] = this.坐标(event);
        const marker = this.选择关键帧(x, y, 22);
        if (marker >= 0) {
            this.拖动 = "关键帧";
            this.拖动关键帧 = marker;
        } else if (this.相机位置 && Math.hypot(x - this.相机位置[0], y - this.相机位置[1]) <= 24) {
            this.拖动 = "相机";
        } else {
            // 点击空白区域：旋转视角（arcball）
            this.拖动 = "视角";
        }
        this.上次位置 = [x, y];
        this.canvas.style.cursor = "grabbing";
    }

    移动(event) {
        if (!this.拖动) return;
        event.preventDefault();
        const [x, y] = this.坐标(event);
        if (this.拖动 === "视角") {
            this.view.水平 -= (x - this.上次位置[0]) * 0.01;
            this.view.俯仰 += (y - this.上次位置[1]) * 0.01;
            this.view.俯仰 = Math.max(-1.4, Math.min(1.4, this.view.俯仰));
            this.上次位置 = [x, y];
        } else if (this.拖动 === "关键帧") {
            const geometry = this.几何();
            const angles = this.view.反投影(
                x - geometry.cx, y - geometry.cy, geometry.radius
            );
            const item = this.关键帧[this.拖动关键帧];
            if (angles && item) {
                item.az = Math.round(angles[0] / 吸附角度) * 吸附角度;
                item.el = Math.round(angles[1] / 吸附角度) * 吸附角度;
                this.写入关键帧();
            }
        } else {
            // 相机拖动：写入水平角度/垂直角度
            const geometry = this.几何();
            const angles = this.view.反投影(
                x - geometry.cx, y - geometry.cy, geometry.radius
            );
            if (angles) {
                const horizontal = 获取控件(this.node, "水平角度");
                const vertical = 获取控件(this.node, "垂直角度");
                if (horizontal) horizontal.value = Math.round(angles[0] / 吸附角度) * 吸附角度;
                if (vertical) vertical.value = Math.round(angles[1] / 吸附角度) * 吸附角度;
                this.node.setDirtyCanvas(true, true);
            }
        }
        this.绘制(true);
    }

    抬起(event) {
        if (!this.拖动) return;
        event?.preventDefault();
        this.拖动 = null;
        this.拖动关键帧 = -1;
        this.canvas.style.cursor = "grab";
    }

    选择关键帧(x, y, radius) {
        let selected = -1;
        let nearest = radius;
        this.关键帧位置.forEach((point, index) => {
            const distance = Math.hypot(x - point[0], y - point[1]);
            if (distance < nearest) {
                nearest = distance;
                selected = index;
            }
        });
        return selected;
    }

    写入关键帧() {
        const widget = 获取控件(this.node, "关键帧");
        if (!widget) return;
        widget.value = JSON.stringify(this.关键帧.map((item) => ({
            f: Math.round(item.f),
            az: Math.round(item.az * 10) / 10,
            el: Math.round(item.el * 10) / 10,
            dist: Math.round(item.dist * 100) / 100,
        })));
        this.node.setDirtyCanvas(true, true);
        this.渲染键 = "";
    }

    右键(event) {
        event.preventDefault();
        event.stopPropagation();
        const [x, y] = this.坐标(event);
        const selected = this.选择关键帧(x, y, 22);
        if (selected >= 0) {
            this.关键帧.splice(selected, 1);
            this.写入关键帧();
            return;
        }
        const geometry = this.几何();
        const angles = this.view.反投影(
            x - geometry.cx, y - geometry.cy, geometry.radius
        );
        if (!angles) return;
        const lastFrame = this.关键帧.length ? this.关键帧[this.关键帧.length - 1].f : -23;
        this.关键帧.push({
            f: Math.max(1, lastFrame + 24),
            az: Math.round(angles[0] / 吸附角度) * 吸附角度,
            el: Math.round(angles[1] / 吸附角度) * 吸附角度,
            dist: Number(获取控件(this.node, "相机距离")?.value ?? 1),
        });
        this.关键帧.sort((a, b) => a.f - b.f);
        const enabled = 获取控件(this.node, "启用关键帧");
        if (enabled) enabled.value = true;
        this.写入关键帧();
    }

    滚轮(event) {
        event.preventDefault();
        event.stopPropagation();
        const [x, y] = this.坐标(event);
        const marker = this.选择关键帧(x, y, 22);
        if (marker >= 0) {
            const item = this.关键帧[marker];
            const next = item.dist - Math.sign(event.deltaY) * 0.05;
            item.dist = Math.max(0.2, Math.min(3, Math.round(next * 100) / 100));
            this.写入关键帧();
            this.绘制(true);
            return;
        }
        const widget = 获取控件(this.node, "相机距离");
        if (!widget) return;
        const next = Number(widget.value) - Math.sign(event.deltaY) * 0.05;
        widget.value = Math.max(0.2, Math.min(3, Math.round(next * 100) / 100));
        this.node.setDirtyCanvas(true, true);
        this.绘制(true);
    }

    绘制(force) {
        const width = this.canvas.clientWidth | 0;
        const height = this.canvas.clientHeight | 0;
        if (width > 0 && height > 0
            && (this.canvas.width !== width || this.canvas.height !== height)) {
            this.canvas.width = width;
            this.canvas.height = height;
            force = true;
        }

        const horizontal = Number(获取控件(this.node, "水平角度")?.value ?? 0);
        const vertical = Number(获取控件(this.node, "垂直角度")?.value ?? 0);
        const distance = Number(获取控件(this.node, "相机距离")?.value ?? 1);
        const keyframeRaw = String(获取控件(this.node, "关键帧")?.value ?? "");
        this.关键帧 = 解析关键帧(keyframeRaw);
        const keyframesEnabled = 获取控件(this.node, "启用关键帧")?.value === true;
        const smooth = 获取控件(this.node, "路径插值")?.value === "平滑";
        const key = [
            horizontal, vertical, distance,
            keyframesEnabled, smooth, keyframeRaw,
            this.view.水平.toFixed(3), this.view.俯仰.toFixed(3),
            this.canvas.width, this.canvas.height,
        ].join("|");
        if (!force && key === this.渲染键) return;
        this.渲染键 = key;

        const ctx = this.ctx;
        const geometry = this.几何();
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = "#1b1b1f";
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        绘制球体(ctx, this.view, geometry.cx, geometry.cy, geometry.radius);

        const 投影 = (az, el) => {
            const [x, front, z] = this.view.旋转(球面点(az, el));
            return [
                geometry.cx + geometry.radius * x,
                geometry.cy - geometry.radius * z,
                front,
            ];
        };

        ctx.strokeStyle = "#d8d8e0";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(geometry.cx, geometry.cy + 12);
        ctx.lineTo(geometry.cx, geometry.cy - 2);
        ctx.stroke();
        ctx.fillStyle = "#d8d8e0";
        ctx.beginPath();
        ctx.arc(geometry.cx, geometry.cy - 8, 5, 0, Math.PI * 2);
        ctx.fill();

        const snaps = [
            [0, 0, "正"], [-45, 0, "左"], [45, 0, "右"],
            [-90, 0, ""], [90, 0, ""], [0, 30, "高"], [0, -15, "低"],
        ];
        for (const [az, el, label] of snaps) {
            const [x, y, front] = 投影(az, el);
            ctx.globalAlpha = front < 0 ? 1 : 0.35;
            ctx.fillStyle = az === 0 && el === 0 ? "#fff" : "#3a4150";
            ctx.strokeStyle = "#9aa2b5";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, label ? 10 : 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (label) {
                ctx.fillStyle = az === 0 && el === 0 ? "#14161b" : "#d9dce3";
                ctx.font = "bold 9px sans-serif";
                const labelWidth = ctx.measureText(label).width;
                ctx.fillText(label, x - labelWidth / 2, y + 3);
            }
        }
        ctx.globalAlpha = 1;

        if (!keyframesEnabled) {
            ctx.strokeStyle = "#78beff";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            for (let index = 0; index <= 14; index++) {
                const [x, y] = 投影(horizontal * index / 14, vertical * index / 14);
                if (index) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
            }
            ctx.stroke();

            const [shellX, shellY, front] = 投影(horizontal, vertical);
            const scale = 距离比例(distance);
            const cameraX = geometry.cx + (shellX - geometry.cx) * scale;
            const cameraY = geometry.cy + (shellY - geometry.cy) * scale;
            this.相机位置 = [cameraX, cameraY];
            ctx.globalAlpha = front < 0 ? 1 : 0.45;
            ctx.fillStyle = "#78beff";
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(cameraX - 13, cameraY - 9, 26, 18, 4);
            else ctx.rect(cameraX - 13, cameraY - 9, 26, 18);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#20242c";
            ctx.beginPath();
            ctx.arc(cameraX + 5, cameraY, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        } else {
            this.相机位置 = null;
        }

        this.关键帧位置 = [];
        if (this.关键帧.length >= 2) {
            const azimuths = 解开角度(this.关键帧.map((item) => item.az));
            const elevations = this.关键帧.map((item) => item.el);
            ctx.globalAlpha = keyframesEnabled ? 1 : 0.22;
            ctx.strokeStyle = "#5fce80";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            let started = false;
            for (let segment = 0; segment < this.关键帧.length - 1; segment++) {
                for (let step = 0; step <= 24; step++) {
                    const amount = step / 24;
                    const az = 角度归一化(插值数值(azimuths, segment, amount, smooth));
                    const el = 插值数值(elevations, segment, amount, smooth);
                    const [x, y] = 投影(az, el);
                    if (started) ctx.lineTo(x, y);
                    else {
                        ctx.moveTo(x, y);
                        started = true;
                    }
                }
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        for (const item of this.关键帧) {
            const [shellX, shellY, front] = 投影(item.az, item.el);
            const scale = 距离比例(item.dist);
            const x = geometry.cx + (shellX - geometry.cx) * scale;
            const y = geometry.cy + (shellY - geometry.cy) * scale;
            this.关键帧位置.push([x, y]);
            ctx.globalAlpha = (keyframesEnabled ? 1 : 0.22) * (front < 0 ? 1 : 0.55);
            ctx.fillStyle = "#5fce80";
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#0e1410";
            ctx.font = "bold 10px sans-serif";
            const label = String(item.f);
            ctx.fillText(label, x - ctx.measureText(label).width / 2, y + 3);
            ctx.globalAlpha = 1;
        }

        ctx.fillStyle = "rgba(220,224,235,0.72)";
        ctx.font = "12px sans-serif";
        const status = keyframesEnabled
            ? `关键帧路径：${this.关键帧.length} 个时间点`
            : `水平 ${horizontal > 0 ? "+" : ""}${horizontal.toFixed(0)}°　`
                + `垂直 ${vertical > 0 ? "+" : ""}${vertical.toFixed(0)}°　距离 ${distance.toFixed(2)}×`;
        ctx.fillText(status, 10, 18);
        ctx.fillStyle = "rgba(200,204,216,0.45)";
        ctx.fillText("右键添加/删除时间点 · 拖动标记改角度 · 标记上滚轮改距离", 10, this.canvas.height - 9);
    }
}

function 挂载轨道球(node) {
    if (!node || node._gjjCrossViewWarpOrbit || typeof node.addDOMWidget !== "function") {
        return;
    }
    try {
            const container = document.createElement("div");
            container.style.width = "100%";
            // 高度由球体高度函数动态返回，不写死，让球体随节点宽度增长
            const canvas = document.createElement("canvas");
            canvas.width = 360;
            canvas.height = 300;
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.display = "block";
            canvas.style.borderRadius = "8px";
            canvas.style.cursor = "grab";
            container.appendChild(canvas);

            const 高度函数 = () => 球体高度(node);
            const widget = node.addDOMWidget("机位轨道球", "GJJ_CrossViewWarp_轨道球", container, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: 高度函数,
                getMaxHeight: 高度函数,
                getHeight: 高度函数,
            });
            if (widget) widget.serialize = false;
            node._gjjCrossViewWarpOrbit = new 轨道球编辑器(node, canvas);
            // Node 2.0 可能在恢复工作流时用保存值覆盖节点高度，因此在
            // 创建/配置结束后做一次固定下限校正；渲染循环不再改变尺寸。
            校正节点高度(node);
    } catch (error) {
        console.error("[GJJ] 跨视角轨道球挂载失败：", error);
    }
}

function 校正节点高度(node) {
    if (!node || node._gjjCrossViewWarpResizePending) return;
    node._gjjCrossViewWarpResizePending = true;
    setTimeout(() => {
        node._gjjCrossViewWarpResizePending = false;
        if (!node.graph || !node._gjjCrossViewWarpOrbit) return;
        const width = Math.max(320, Math.floor(Number(node.size?.[0] || 0)));
        const height = Math.max(节点最小高度, Math.floor(Number(node.size?.[1] || 0)));
        if (width !== node.size?.[0] || height !== node.size?.[1]) {
            node.setSize?.([width, height]);
        }
        node.setDirtyCanvas?.(true, true);
    }, 80);
}

app.registerExtension({
    name: "GJJ.跨视角轨道球",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== 节点键) return;
        const 原创建函数 = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = 原创建函数?.apply(this, arguments);
            挂载轨道球(this);
            return result;
        };
        const 原配置函数 = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = 原配置函数?.apply(this, arguments);
            挂载轨道球(this);
            校正节点高度(this);
            return result;
        };
    },
    nodeCreated(node) {
        const nodeClass = node?.comfyClass || node?.type;
        if (nodeClass === 节点键) {
            // Node 2.0 某些版本不会执行覆写后的 onNodeCreated，这里按实例兜底。
            queueMicrotask(() => 挂载轨道球(node));
        }
    },
});

// GJJ · 创建边界框画布 —— 前端扩展（v3.7·v37：修复上游重复预览——MultiImageLoader 只走 outputs 通道，previews 仅对自身带预览的模板参数类节点覆写 + 收集去重）
// =====================================================================
// 画布组件背景来自 nodeOutputStore.getNodeImageUrls(background 上游)：
// 只有 LoadImage（uploadImage 写 store）与 OUTPUT_NODE（执行后记录）能命中，
// GJJ_MultiImageLoader、「模板参数输入器」等普通 IMAGE 源从不写入 store，
// 因此背景永远空白。
//
// 本扩展改为**全局轮询**：扫描全图所有 GJJ_CreateBoundingBoxes 节点，
// 从 background 上游收集图片（本地文件名 / 网络 URL），
// 双通道注入 store（outputs + previews 同时写），
// 官方 backgroundUrl computed 自动重算，画布预览随即更新。
// 节点标题角标直接显示：版本 · 收集图数 · 读回结果（√N=成功 / 写入失败(读回空)）。
//
// ★ v3.6 关键修复（背景一直空白的真正根因）：
//   官方 store 的源路径 /stores/nodeOutputStore.js 在构建后的前端是 404，
//   旧版 getOutputStore 永远返回 null → 注入从未执行。
//   真实 store 工厂是打包 chunk settingStore-*.js 的命名导出 Sn（useNodeOutputStore），
//   在 app 初始化后（activePinia 可用）调用 factory() 即可取得 store 实例。
//   本版改为运行时自动发现已加载的 settingStore chunk 并取 Sn()。
// =====================================================================

import { app } from "/scripts/app.js";

const TARGET_CLASS = "GJJ_CreateBoundingBoxes";
const BACKGROUND_INPUT = "background";
const INTERNAL_WIDGETS = new Set(["last_incoming"]);
const MIN_WIDTH = 420;
const MIN_HEIGHT = 560;
const CANVAS_MIN_HEIGHT = 300;
const POLL_MS = 700;
const STORE_MODULE_CANDIDATES = [
	"/stores/nodeOutputStore.js",
	"/scripts/stores/nodeOutputStore.js",
];

let outputStorePromise = null;

async function getOutputStore() {
	if (outputStorePromise) return outputStorePromise;
	outputStorePromise = (async () => {
		// 候选 1-2：源路径（部分开发模式前端可用）
		for (const path of STORE_MODULE_CANDIDATES) {
			try {
				const mod = await import(path);
				const store = mod?.useNodeOutputStore?.();
				if (store && typeof store.getNodeImageUrls === "function") return store;
			} catch (_) {}
		}
		// 候选 3（v3.6）：从已加载资源自动发现 settingStore chunk，取命名导出 Sn（useNodeOutputStore 工厂）
		try {
			const loaded = performance
				.getEntriesByType("resource")
				.map((e) => String(e.name || ""));
			const chunkUrl = loaded.find((n) => /settingStore-[A-Za-z0-9_-]+\.js$/.test(n));
			if (chunkUrl) {
				const mod = await import(chunkUrl);
				const factory = mod?.Sn || mod?.useNodeOutputStore;
				if (typeof factory === "function") {
					// 从模块导出里尝试找 pinia 实例（_s 特征），传入工厂兜底
					let pinia = null;
					for (const k of Object.keys(mod)) {
						const v = mod[k];
						if (v && typeof v === "object" && v._s && typeof v.use === "function") {
							pinia = v;
							break;
						}
					}
					try {
						const store = pinia ? factory(pinia) : factory();
						if (store && typeof store.getNodeImageUrls === "function") return store;
					} catch (e) {
						console.warn(
							"[GJJ_CreateBoundingBoxes] store 工厂调用失败（app 未初始化或无 pinia 上下文）：",
							e?.message || e
						);
					}
				}
			}
		} catch (_) {}
		console.warn(
			"[GJJ_CreateBoundingBoxes] 无法加载 nodeOutputStore，背景预览桥接不可用；" +
				"请确认 ComfyUI 前端为 0.37+ 版本。"
		);
		return null;
	})();
	return outputStorePromise;
}

// ---------------------------------------------------------------------------
// 上游解析（沿 Reroute 回溯，按输入名 background 查找）
// ---------------------------------------------------------------------------

function findInputSlot(node, name) {
	const inputs = node?.inputs ?? [];
	for (let i = 0; i < inputs.length; i++) {
		if (inputs[i]?.name === name) return i;
	}
	return -1;
}

function resolveSourceNode(node) {
	const slot = findInputSlot(node, BACKGROUND_INPUT);
	if (slot < 0 || !node?.inputs?.[slot]?.link) return null;
	const link = node.graph?.links?.[node.inputs[slot].link];
	if (!link) return null;
	let origin = node.graph?.getNodeById?.(link.origin_id) ?? null;
	let guard = 0;
	const isReroute = (n) => {
		if (!n) return false;
		const cls = String(n.comfyClass || n.type || "");
		const title = String(n.constructor?.title || n.title || "");
		return cls === "Reroute" || title.includes("Reroute") || title.includes("路由");
	};
	while (origin && isReroute(origin) && guard++ < 8) {
		const inSlot = (origin.inputs ?? []).findIndex((i) => i.link != null);
		if (inSlot < 0) break;
		const l2 = origin.graph?.links?.[origin.inputs[inSlot].link];
		if (!l2) break;
		origin = origin.graph?.getNodeById?.(l2.origin_id) ?? null;
	}
	return origin;
}

// ---------------------------------------------------------------------------
// 取值 → 图片条目（与模板参数输入器 mediaRefToViewUrl 同语义）
// ---------------------------------------------------------------------------

function isDirectUrl(text) {
	return /^(?:blob:|data:|https?:\/\/)/i.test(String(text || "").trim());
}

// 本地文件名 → {filename, type, subfolder}
function localItemFromText(text) {
	text = String(text || "").trim().replace(/\\/g, "/");
	if (!text) return null;
	let type = "input";
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	if (annotated) {
		type = annotated[1].toLowerCase();
		text = text.slice(0, annotated.index).trim();
	}
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) {
		type = parts.shift().toLowerCase();
	}
	const filename = parts.pop() || text;
	const subfolder = parts.join("/");
	if (!filename) return null;
	return { filename, type, subfolder };
}

// 字符串 → item：网络/blob/data 直出 URL；否则本地文件名
function itemFromText(text) {
	text = String(text || "").trim();
	if (!text) return null;
	if (isDirectUrl(text)) return { url: text };
	return localItemFromText(text);
}

// ---------------------------------------------------------------------------
// 图片收集（通用：GJJ_MultiImageLoader / 模板参数输入器 / 任意 widget/属性）
// ---------------------------------------------------------------------------

const IMAGE_KEY_RE = /image|img|图片|图|thumb|preview|photo/i;

function collectItems(node) {
	if (!node) return [];
	const out = [];
	// 去重：同一图片（URL 或 filename）只保留一次，避免上游预览重复
	const dedupe = (arr) => {
		const seen = new Set();
		return arr.filter((i) => {
			const key = i.url
				? `u:${i.url}`
				: `f:${i.filename}:${i.type}:${i.subfolder || ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};

	// 1) GJJ_MultiImageLoader：执行结果 / 当前选中
	try {
		const st = node.__gjjMultiImageState;
		const arr = st?.executedImages?.length
			? st.executedImages
			: st?.selection || [];
		for (const it of arr) {
			if (!it) continue;
			if (it.url || isDirectUrl(it.filename)) {
				out.push({ url: it.url || it.filename });
			} else if (it.filename) {
				out.push({
					filename: String(it.filename),
					type: String(it.type || "input"),
					subfolder: String(it.subfolder || ""),
				});
			}
		}
		if (out.length) return dedupe(out);
	} catch (_) {}

	// 2) 模板参数输入器：内部行数据（key → {value}）
	try {
		const rows = node.__gjjTemplateParamsRows;
		if (rows) {
			for (const v of rows.values()) {
				if (v && typeof v.value === "string" && v.value.trim()) {
					const item = itemFromText(v.value.trim());
					if (item) out.push(item);
				}
			}
			if (out.length) return dedupe(out);
		}
	} catch (_) {}

	// 3) 模板参数输入器：网络媒体映射（key → {url, path}，path 为本地缓存路径）
	try {
		const mappings = node.__gjjTemplateParamsNetworkMappings;
		if (mappings) {
			for (const v of mappings.values()) {
				if (!v) continue;
				if (v.url) out.push({ url: String(v.url) });
				else if (v.path) {
					const item = localItemFromText(v.path);
					if (item) out.push(item);
				}
			}
			if (out.length) return dedupe(out);
		}
	} catch (_) {}

	// 4) 图片相关 widget（param_* 动态字段 / 原生 image widget）
	for (const w of node.widgets ?? []) {
		if (!w || w.hidden || w.type === "hidden") continue;
		const name = String(w.name || "");
		if (!IMAGE_KEY_RE.test(name)) continue;
		const val = w.value;
		if (typeof val === "string" && val.trim()) {
			const item = itemFromText(val.trim());
			if (item) out.push(item);
		}
	}
	if (out.length) return out;

	// 5) 节点属性中的图片字段（浅层扫描；兼容 JSON 字符串与数组两种形态）
	try {
		const props = node.properties ?? {};
		for (const key of Object.keys(props)) {
			if (!IMAGE_KEY_RE.test(key)) continue;
			const val = props[key];
			if (Array.isArray(val)) {
				for (const it of val) {
					if (!it) continue;
					if (typeof it === "string" && it.trim()) {
						const item = itemFromText(it.trim());
						if (item) out.push(item);
					} else if (typeof it === "object") {
						const f = it.filename ?? it.image ?? it.path ?? it.url;
						if (!f) continue;
						if (isDirectUrl(f)) out.push({ url: String(f) });
						else {
							const item = localItemFromText(String(f));
							if (item) {
								item.type = String(it.type || item.type || "input");
								item.subfolder = String(it.subfolder || item.subfolder || "");
								out.push(item);
							}
						}
					}
				}
			} else if (typeof val === "string" && val.trim()) {
				const item = itemFromText(val.trim());
				if (item) out.push(item);
			}
		}
	} catch (_) {}

	return dedupe(out);
}

function signatureOf(items) {
	return items
		.map((i) => (i.url ? `url:${i.url}` : `${i.filename}:${i.type}:${i.subfolder || ""}`))
		.join("|");
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

const injected = new Map(); // 上游 node.id -> 上次签名

// 节点标题状态角标：无需打开控制台即可在节点标题看到桥接状态
function updateStatusTitle(node, status) {
	if (!node) return;
	const current = String(node.title || "");
	const clean = current.replace(/\s*\[[^\]]*\]\s*$/, "").trim() || "创建边界框画布";
	const next = status ? `${clean} [${status}]` : clean;
	if (node.title !== next) {
		node.title = next;
		node.graph?.setDirtyCanvas?.(false, true);
	}
}

async function injectImages(upstream, target) {
	const items = collectItems(upstream);
	if (!items.length) {
		updateStatusTitle(target, "上游无图数据");
		return;
	}
	const sig = signatureOf(items);
	if (injected.get(String(upstream.id)) === sig) {
		updateStatusTitle(target, `背景 ${items.length} 图`);
		return;
	}
	// 注意：injected 标记移到注入成功读回之后——失败不标记，轮询自动重试

	const store = await getOutputStore();
	if (!store) {
		updateStatusTitle(target, "桥接不可用(store 未加载)");
		return;
	}

	const localItems = items.filter((i) => !i.url);
	const urls = items.filter((i) => i.url).map((i) => i.url);

	// 本地文件 → 官方 /view URL（previews 通道需要直接 URL）
	const viewUrlOf = (i) =>
		`/view?filename=${encodeURIComponent(i.filename)}` +
		`&type=${encodeURIComponent(i.type || "input")}` +
		(i.subfolder ? `&subfolder=${encodeURIComponent(i.subfolder)}` : "");

	// 上游类型识别：GJJ_MultiImageLoader 自带图片列表 UI（自身渲染预览），
	// 若把 previews 写给它会污染其预览（多出重复图），因此只走 outputs 通道；
	// 模板参数输入器等自身已带 previews 的节点才需要 previews 覆写。
	const upstreamCls = String(upstream.comfyClass || upstream.type || "");
	const upstreamTitle = String(upstream.title || "");
	const isMultiLoader =
		/multi.?image.?loader|批量多图|多图加载/i.test(upstreamCls + upstreamTitle);

	try {
		// 注入前读取上游已有 previews（判断是否需要覆写——自身无 previews 的节点走 outputs 即可）
		let readBack0 = null;
		try {
			readBack0 = await store.getNodeImageUrls?.(upstream);
		} catch (_) {}
		// 通道一：outputs（官方 LoadImage 同款机制；API 名多版本兜底）
		if (localItems.length) {
			const imageObjs = localItems.map((i) => ({
				filename: i.filename,
				type: i.type,
				subfolder: i.subfolder || "",
			}));
			if (store.setNodeOutputImages) {
				store.setNodeOutputImages(upstream, imageObjs);
			} else if (store.setNodeOutputs) {
				store.setNodeOutputs(
					upstream,
					localItems.map((i) => i.filename),
					{ folder: "input" }
				);
			}
		}
		// 通道二：previews（getNodeImageUrls 中 previews 优先于 outputs，
		// 模板参数输入器等 GJJ 节点可能已写 previews 覆盖 outputs，故直接覆写为我们的 URL）。
		// ★ v3.7：GJJ_MultiImageLoader 自带图片列表 UI，写 previews 会在其节点上
		//   多出重复预览图；因此仅对非 MultiLoader 且上游自身已有 previews 的节点
		//   （模板参数输入器等）覆写 previews，避免污染上游 UI。
		const allUrls = [...localItems.map(viewUrlOf), ...urls];
		const hasOwnPreviews = Array.isArray(readBack0) && readBack0.length > 0;
		if (
			!isMultiLoader &&
			hasOwnPreviews &&
			allUrls.length &&
			store.setNodePreviewsByNodeId
		) {
			store.setNodePreviewsByNodeId(upstream.id, allUrls);
		}
		// 注入后读回（诊断）：getNodeImageUrls 需要节点对象
		let readBack = null;
		try {
			readBack = await store.getNodeImageUrls?.(upstream);
		} catch (_) {}
		const rbCount = Array.isArray(readBack) ? readBack.length : readBack ? 1 : 0;
		if (rbCount > 0) {
			// 注入成功且读回成功——标记去重，避免重复注入
			injected.set(String(upstream.id), sig);
			updateStatusTitle(target, `v37·背景 ${items.length} 图·√${rbCount}`);
		} else {
			// 读回为空——不标记，下次轮询自动重试
			updateStatusTitle(target, "v37·写入失败(读回空)");
		}
		console.log(
			`[GJJ_CreateBoundingBoxes] 背景预览注入 ${upstream.comfyClass || upstream.type} -> 图数=${items.length} 读回=${rbCount} readBack=${JSON.stringify(readBack)} allUrls=${JSON.stringify(allUrls)}`
		);
	} catch (error) {
		updateStatusTitle(target, "注入失败");
		console.warn("[GJJ_CreateBoundingBoxes] 背景预览注入失败：", error);
	}
}

// ---------------------------------------------------------------------------
// 全局轮询：扫描全图所有目标节点
// ---------------------------------------------------------------------------

// 目标节点匹配：onNodeCreated 标记优先，类型名多路兜底。
// 不同前端版本中 node.comfyClass / node.type 取值不同，
// 单一条件一旦落空会静默跳过全部节点，导致注入完全失效。
function isTargetNode(node) {
	if (!node) return false;
	if (node.__gjjBBoxTarget === true) return true;
	const cls = String(node.comfyClass || node.type || "");
	const title = String(node.constructor?.title || node.title || "");
	return cls.includes("GJJ_CreateBoundingBoxes") || title.includes("创建边界框画布");
}

let lastTargetCount = -1;

function pollOnce() {
	const graph = app.graph;
	const nodes = graph?._nodes ?? [];
	let targetCount = 0;
	for (const node of nodes) {
		if (!isTargetNode(node)) continue;
		targetCount++;
		const upstream = resolveSourceNode(node);
		if (!upstream) {
			updateStatusTitle(node, "未连接背景");
			continue;
		}
		injectImages(upstream, node);
	}
	if (targetCount !== lastTargetCount) {
		console.debug(`[GJJ_CreateBoundingBoxes] 轮询命中目标节点数: ${targetCount}`);
		lastTargetCount = targetCount;
	}
}

// ---------------------------------------------------------------------------
// 画布高度兜底：防止画布 widget 布局塌陷导致无法绘制
// ---------------------------------------------------------------------------

function ensureCanvasHeight(node) {
	const editor = (node.widgets ?? []).find((w) => w && w.name === "editor_state");
	if (!editor) return;
	if (editor.options && typeof editor.options.getMinHeight !== "function") {
		editor.options.getMinHeight = () => CANVAS_MIN_HEIGHT;
	}
	if (editor.element) {
		editor.element.style.setProperty("--comfy-widget-min-height", `${CANVAS_MIN_HEIGHT}px`);
	}
	if (typeof node.setSize === "function" && Array.isArray(node.size)) {
		node.setSize([node.size[0], node.size[1]]);
	}
	node.graph?.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------------------
// 扩展注册
// ---------------------------------------------------------------------------

app.registerExtension({
	name: "GJJ.CreateBoundingBoxes",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_CLASS) return;

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = onNodeCreated?.apply(this, arguments);

			// 标记目标节点：轮询据此匹配（comfyClass/type 多版本兜底见 isTargetNode）
			this.__gjjBBoxTarget = true;

			if (Array.isArray(this.size) && typeof this.setSize === "function") {
				this.setSize([
					Math.max(this.size[0], MIN_WIDTH),
					Math.max(this.size[1], MIN_HEIGHT),
				]);
			}
			for (const widget of this.widgets ?? []) {
				if (INTERNAL_WIDGETS.has(widget?.name)) {
					widget.hidden = true;
					if ("serialize" in widget) widget.serialize = false;
				}
			}

			ensureCanvasHeight(this);

			console.log("[GJJ_CreateBoundingBoxes] 节点就绪：", {
				size: this.size,
				widgets: (this.widgets ?? []).map((w) => ({
					name: w?.name,
					type: w?.type,
					hidden: !!w?.hidden,
					hasElement: !!w?.element,
				})),
			});

			return result;
		};
	},
});

// 扩展脚本加载完成后立即启动全局轮询
setTimeout(() => {
	try {
		pollOnce();
		setInterval(pollOnce, POLL_MS);
	} catch (error) {
		console.warn("[GJJ_CreateBoundingBoxes] 轮询启动失败：", error);
	}
}, 500);

// ---------------------------------------------------------------------------
// 调试/自动化接口（供外部脚本验证连线与注入；不影响正常功能）
// ---------------------------------------------------------------------------
try {
	window.__GJJ_BBOX_DEBUG__ = {
		nodes() {
			return (app.graph?._nodes ?? []).map((n) => ({
				id: n.id,
				type: n.type,
				title: n.title,
				cls: n.comfyClass,
				inputs: (n.inputs ?? []).map((i) => ({ name: i.name, slot: i.slot, link: i.link })),
				outputs: (n.outputs ?? []).map((o) => ({ name: o.name, slot: o.slot, links: o.links })),
			}));
		},
		connect(originId, originSlot, targetId, targetSlot) {
			try {
				const ok = app.graph.connect(originId, originSlot, targetId, targetSlot);
				return ok ? "connected" : "connect returned falsy";
			} catch (e) {
				return "ERR:" + (e && e.message || e);
			}
		},
		graph() {
			return {
				nodeCount: (app.graph?._nodes ?? []).length,
				linkCount: Object.keys(app.graph?.links ?? {}).length,
			};
		},
	};
} catch (e) {
	console.warn("[GJJ_CreateBoundingBoxes] 调试接口注册失败：", e);
}

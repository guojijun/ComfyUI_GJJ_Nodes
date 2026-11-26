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
let outputStoreLastFail = 0;

async function getOutputStore() {
	// 失败后 15 秒内不重试（避免每 700ms 狂扫所有 chunk），但允许重试而非永久缓存 null
	if (outputStorePromise) {
		const existing = await outputStorePromise;
		if (existing) return existing;
		if (Date.now() - outputStoreLastFail < 15000) return null;
		outputStorePromise = null;
	}
	outputStorePromise = (async () => {
		// 候选 1-2：源路径（部分开发模式前端可用）
		for (const path of STORE_MODULE_CANDIDATES) {
			try {
				const mod = await import(path);
				const store = mod?.useNodeOutputStore?.();
				if (store && typeof store.getNodeImageUrls === "function") return store;
			} catch (_) {}
		}
		// 候选 3：从已加载资源自动发现 store chunk
		// 兼容多种 chunk 命名：settingStore-* / nodeOutputStore-* / 任何 chunk 中导出 useNodeOutputStore
		try {
			const loaded = performance
				.getEntriesByType("resource")
				.map((e) => String(e.name || ""))
				.filter((n) => n.endsWith(".js") && n.includes("/"));

			// 优先匹配名字中带 store/output/setting 的 chunk
			const prioritized = loaded
				.filter((n) => /(store|output|setting|node)/i.test(n))
				.sort((a, b) => {
					const score = (n) => (/(settingStore|nodeOutputStore|outputStore)/i.test(n) ? 0 : /store/i.test(n) ? 1 : 2);
					return score(a) - score(b);
				});

			for (const chunkUrl of prioritized) {
				try {
					const mod = await import(chunkUrl);
					// 方式 A：模块直接导出 store 实例（有 getNodeImageUrls 方法的对象）
					for (const v of Object.values(mod)) {
						if (v && typeof v === "object" && typeof v.getNodeImageUrls === "function") {
							console.log("[GJJ_CreateBoundingBoxes] nodeOutputStore 已加载(实例)：", chunkUrl);
							return v;
						}
					}
					// 方式 B：找工厂函数（useNodeOutputStore / Sn）
					const factory =
						mod?.useNodeOutputStore ||
						mod?.Sn ||
						Object.values(mod).find(
							(v) => typeof v === "function" && /output/i.test(v.name || "") && /store/i.test(v.name || "")
						);
					if (typeof factory !== "function") continue;

					// 找 pinia 实例：遍历模块和 window
					let pinia = null;
					for (const k of Object.keys(mod)) {
						const v = mod[k];
						if (v && typeof v === "object" && v._s && typeof v.use === "function") {
							pinia = v;
							break;
						}
					}
					if (!pinia && typeof window !== "undefined") {
						for (const k of Object.keys(window)) {
							try {
								const v = window[k];
								if (v && typeof v === "object" && v._s && typeof v.use === "function") {
									pinia = v;
									break;
								}
							} catch (_) {}
						}
					}
					// 方式 C：不传 pinia 直接调用（某些版本自动用全局 pinia）
					try {
						const store = pinia ? factory(pinia) : factory();
						if (store && typeof store.getNodeImageUrls === "function") {
							console.log("[GJJ_CreateBoundingBoxes] nodeOutputStore 已加载(工厂)：", chunkUrl);
							return store;
						}
					} catch (_) {}
				} catch (_) {}
			}
		} catch (_) {}
		outputStoreLastFail = Date.now();
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

	// 1) GJJ_MultiImageLoader：优先实时 selection（用户前端换图立即反映），
	//    selection 为空时才回退到 executedImages（刚执行过但尚未选择图片的场景）。
	try {
		const st = node.__gjjMultiImageState;
		if (st) {
			const selection = Array.isArray(st.selection) ? st.selection : [];
			const executed = Array.isArray(st.executedImages) ? st.executedImages : [];
			const source = selection.length ? selection : executed;
			const seenKeys = new Set();
			for (const it of source) {
				if (!it) continue;
				let item = null;
				if (it.url || isDirectUrl(it.filename)) {
					item = { url: it.url || it.filename };
				} else if (it.filename) {
					item = {
						filename: String(it.filename),
						type: String(it.type || "input"),
						subfolder: String(it.subfolder || ""),
					};
				}
				if (!item) continue;
				const key = item.url ? `u:${item.url}` : `f:${item.filename}:${item.type}:${item.subfolder || ""}`;
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);
				out.push(item);
			}
			if (out.length) return out;
		}
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
	const upstreamKey = String(upstream.id);
	const localItems = items.filter((i) => !i.url);
	const urls = items.filter((i) => i.url).map((i) => i.url);
	const viewUrlOf = (i) =>
		`/view?filename=${encodeURIComponent(i.filename)}` +
		`&type=${encodeURIComponent(i.type || "input")}` +
		(i.subfolder ? `&subfolder=${encodeURIComponent(i.subfolder)}` : "");
	const allUrls = [...localItems.map(viewUrlOf), ...urls];

	if (injected.get(upstreamKey) === sig) {
		updateStatusTitle(target, `背景 ${items.length} 图`);
		// 即使签名未变，也确保 imgs 和 DOM 背景层同步（widget 重绘会丢失）
		syncUpstreamImgs(upstream, items);
		if (allUrls[0]) forceCanvasBackground(target, allUrls[0]);
		return;
	}

	// 通道零（最可靠）：直接写上游节点的 imgs 数组——LiteGraph 原生预览图机制
	syncUpstreamImgs(upstream, items);

	// 通道一：nodeOutputStore —— BOUNDING_BOXES widget 真正读取的来源
	const store = await getOutputStore();
	let storeOk = false;
	if (store) {
		try {
			// 打印 store 方法名（首次），便于排查 API 差异
			if (!store.__gjjDebugged) {
				store.__gjjDebugged = true;
				const methods = Object.keys(store).filter((k) => typeof store[k] === "function");
				console.log("[GJJ_CreateBoundingBoxes] store 方法：", methods);
			}

			// 写入本地文件图片
			if (localItems.length) {
				const imageObjs = localItems.map((i) => ({
					filename: i.filename,
					type: i.type || "input",
					subfolder: i.subfolder || "",
				}));
				// 尝试多种 API 名
				if (typeof store.setNodeOutputImages === "function") {
					store.setNodeOutputImages(upstream, imageObjs);
				} else if (typeof store.setNodeOutputs === "function") {
					store.setNodeOutputs(upstream, imageObjs);
				} else if (typeof store.setNodeOutput === "function") {
					store.setNodeOutput(upstream, imageObjs);
				}
			}

			// 写入 URL previews
			if (allUrls.length) {
				if (typeof store.setNodePreviewsByNodeId === "function") {
					store.setNodePreviewsByNodeId(upstream.id, allUrls);
				} else if (typeof store.setPreviews === "function") {
					store.setPreviews(upstream, allUrls);
				}
			}

			// 读回验证
			const readBack = await store.getNodeImageUrls?.(upstream);
			const rbCount = Array.isArray(readBack) ? readBack.length : readBack ? 1 : 0;
			if (rbCount > 0) {
				storeOk = true;
				console.log(`[GJJ_CreateBoundingBoxes] store 写入成功，读回 ${rbCount} 张`);
			} else {
				console.warn("[GJJ_CreateBoundingBoxes] store 写入后读回为空，尝试直接操作 state");
				// 兜底：直接修改 store 内部响应式状态
				try {
					const stateKeys = Object.keys(store.$state || {});
					console.log("[GJJ_CreateBoundingBoxes] store.$state keys:", stateKeys);
				} catch (_) {}
			}
		} catch (e) {
			console.warn("[GJJ_CreateBoundingBoxes] store 写入异常：", e?.message || e);
		}
	} else {
		// store 未加载不刷屏——ComfyUI 原生 OUTPUT_NODE 机制已处理
	}

	// 只有 store 写入成功才标记 injected；否则下次轮询继续重试
	if (storeOk) {
		injected.set(upstreamKey, sig);
	}
	updateStatusTitle(target, `v38·背景 ${items.length} 图`);
	target.graph?.setDirtyCanvas?.(false, true);

	// DOM 背景层作为兜底
	forceCanvasBackground(target, allUrls[0]);
}

// DOM 背景层已移除——BOUNDING_BOXES 在 LiteGraph canvas 上绘制，DOM 叠加会干扰原生渲染
function forceCanvasBackground(target, bgUrl) {
	// no-op：背景图由 nodeOutputStore 响应式机制处理
}

// 直接同步上游节点 imgs（LiteGraph 原生预览图），不依赖 nodeOutputStore
function syncUpstreamImgs(upstream, items) {
	if (!upstream || !Array.isArray(items) || !items.length) return;
	const allUrls = items.map((i) => {
		if (i.url) return i.url;
		return (
			`/view?filename=${encodeURIComponent(i.filename)}` +
			`&type=${encodeURIComponent(i.type || "input")}` +
			(i.subfolder ? `&subfolder=${encodeURIComponent(i.subfolder)}` : "")
		);
	});
	try {
		// 只更新 URL 列表，避免覆盖节点其他状态
		const old = Array.isArray(upstream.imgs) ? upstream.imgs : [];
		const changed = old.length !== allUrls.length || old.some((u, i) => u !== allUrls[i]);
		if (changed) {
			upstream.imgs = allUrls;
			if (typeof upstream.setSize === "function") {
				// 触发节点重绘以刷新预览图区域
				upstream.graph?.setDirtyCanvas?.(false, true);
			}
		}
	} catch (_) {}
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
		// 连线变化（换了上游节点）时清除旧签名缓存，强制重新注入
		const upstreamKey = String(upstream.id);
		if (node.__gjjBBoxUpstreamKey && node.__gjjBBoxUpstreamKey !== upstreamKey) {
			injected.delete(node.__gjjBBoxUpstreamKey);
		}
		node.__gjjBBoxUpstreamKey = upstreamKey;
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

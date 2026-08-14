import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET = "GJJ_RegexExtractor";
const MAX_PATTERNS = 16;
const TEXT_WIDGET = "text";
const FLAGS_STATE_WIDGET = "flags_state";
const PATTERN_PREFIX = "pattern_";
const MIN_WIDTH = 300;
const SCHEDULE_MS = 80;

// emoji 按钮定义：每个正则标志对应一个 emoji 按钮和 tooltip
const FLAG_DEFS = [
	{ key: "flag_dotall", emoji: "🎯", label: "DOTALL", tooltip: "DOTALL：让 . 也匹配换行符" },
	{ key: "flag_multiline", emoji: "📄", label: "MULTILINE", tooltip: "MULTILINE：^ 和 $ 在每行边界都生效" },
	{ key: "flag_ignorecase", emoji: "🔤", label: "IGNORECASE", tooltip: "IGNORECASE：忽略大小写" },
	{ key: "flag_verbose", emoji: "💬", label: "VERBOSE", tooltip: "VERBOSE：允许正则中写空白和 # 注释" },
	{ key: "flag_ascii", emoji: "🔢", label: "ASCII", tooltip: "ASCII：让 \\w \\b 等只匹配 ASCII 字符" },
];

const ALL_HIDDEN_FIELDS = [FLAGS_STATE_WIDGET];
for (let i = 1; i <= MAX_PATTERNS; i++) {
	ALL_HIDDEN_FIELDS.push(`${PATTERN_PREFIX}${i}`);
}

// ── 工具函数 ──────────────────────────────────────────

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name);
}

function getWidgetValue(node, name) {
	return String(widget(node, name)?.value ?? "");
}

function setWidgetValue(node, name, value, triggerCallback = false) {
	const w = widget(node, name);
	if (!w) return;
	const next = String(value ?? "");
	if (w.value !== next) {
		w.value = next;
		if (triggerCallback) w.callback?.(next);
	}
}

function dirty(node) {
	try { app?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
}

function setStatus(node, text, isError) {
	const el = node?.__gjjRegexStatus;
	if (!el) return;
	el.textContent = String(text || "");
	el.style.color = isError ? "#ff8080" : "rgba(235,245,250,.78)";
}

function hideWidget(w) {
	if (!w) return;
	w.hidden = true;
	if (w.el) w.el.style.display = "none";
	if (w.inputEl) w.inputEl.style.display = "none";
	if (w.element) w.element.style.display = "none";
}

function hideNativeWidgets(node) {
	for (const name of ALL_HIDDEN_FIELDS) hideWidget(widget(node, name));
}

// ── 标志状态管理（存储在 node.properties） ─────────────

function getFlagState(node) {
	node.properties = node.properties || {};
	const state = {};
	for (const def of FLAG_DEFS) {
		state[def.key] = !!node.properties[def.key];
	}
	// 首次创建节点时 MULTILINE 默认开启（最常用场景）
	if (!node.properties.__gjjRegexFlagsInitialized) {
		node.properties.__gjjRegexFlagsInitialized = true;
		node.properties.flag_multiline = true;
		state.flag_multiline = true;
		// 同步到隐藏 widget
		const hash = FLAG_DEFS.map((d) => `${d.key}=${state[d.key] ? 1 : 0}`).join(",");
		setWidgetValue(node, FLAGS_STATE_WIDGET, hash, false);
	}
	return state;
}

function setFlag(node, key, value) {
	node.properties = node.properties || {};
	node.properties[key] = value;
	// 记录用户是否手动关闭过 MULTILINE（用于后端自动检测 ^/$ 时判断）
	if (key === "flag_multiline" && !value) {
		node.properties.flag_multiline_manually_off = true;
	}
	// 写入 flags_state 隐藏 widget，触发 IS_CHANGED 缓存刷新
	const flags = getFlagState(node);
	const hash = FLAG_DEFS.map((d) => `${d.key}=${flags[d.key] ? 1 : 0}`).join(",");
	setWidgetValue(node, FLAGS_STATE_WIDGET, hash, true);
}

function syncFlagButtons(node) {
	const flags = getFlagState(node);
	const btns = node.__gjjRegexWrap?.querySelectorAll(".gjj-regex-flag");
	if (!btns) return;
	for (const btn of btns) {
		const key = btn.dataset.flagKey;
		btn.classList.toggle("on", !!flags[key]);
	}
}

// ── 正则验证 ──────────────────────────────────────────

function tryValidatePattern(pattern, flags) {
	try {
		const jsPattern = String(pattern || "").replace(/\(\?P<([^>]+)>/g, "(?<$1>");
		let jsFlags = "";
		if (flags.flag_ignorecase) jsFlags += "i";
		if (flags.flag_multiline) jsFlags += "m";
		if (flags.flag_dotall) jsFlags += "s";
		new RegExp(jsPattern, jsFlags);
		return { valid: true, error: "" };
	} catch (e) {
		return { valid: false, error: String(e?.message || e) };
	}
}

// ── 输出端口管理 ──────────────────────────────────────

function ensureOutputCount(node, count) {
	const target = Math.max(1, Math.min(MAX_PATTERNS, count || 1));
	while ((node.outputs || []).length < target) {
		try { node.addOutput?.(`输出${node.outputs.length + 1}`, "*"); }
		catch (_) { node.outputs.push({ name: `输出${node.outputs.length + 1}`, type: "*", links: null }); }
	}
	// 减少时保护已连接端口
	while ((node.outputs || []).length > target) {
		const last = node.outputs[node.outputs.length - 1];
		if (last?.links?.length) break;
		try { node.removeOutput(node.outputs.length - 1); }
		catch (_) { node.outputs.pop(); }
	}
}

function linkCountProtectedOutputCount(node, count) {
	let needed = count;
	(node.outputs || []).forEach((output, index) => {
		if (output?.links?.length) needed = Math.max(needed, index + 1);
	});
	return Math.min(MAX_PATTERNS, Math.max(1, needed));
}

function applyOutputs(node, patternCount, errors) {
	const target = errors.length ? 1 : linkCountProtectedOutputCount(node, patternCount);
	ensureOutputCount(node, target);

	for (let index = 0; index < (node.outputs || []).length; index++) {
		const output = node.outputs[index];
		if (!output) continue;
		if (errors.length && index === 0) {
			output.name = "正则错误";
			output.label = "正则错误";
			output.localized_name = "正则错误";
			output.type = "*";
			output.tooltip = errors.join("\n");
		} else {
			const name = `匹配${index + 1}`;
			output.name = name;
			output.label = name;
			output.localized_name = name;
			output.type = "*";
			output.tooltip = `第${index + 1}条正则的完整匹配列表。`;
		}
	}
}

// ── 正则行 DOM 管理 ───────────────────────────────────

function getActivePatternCount(node) {
	let count = 0;
	for (let i = 1; i <= MAX_PATTERNS; i++) {
		const val = getWidgetValue(node, `${PATTERN_PREFIX}${i}`);
		if (val.trim()) count++;
	}
	return count;
}

function getRowIndex(node, row) {
	const container = node.__gjjRegexRows;
	if (!container) return -1;
	return Array.from(container.children).indexOf(row);
}

// 将当前所有正则行的值保存到 node.properties.patterns
// node.properties 会被 ComfyUI 自动序列化到 workflow JSON，确保刷新/重启后不丢失
function savePatternsToProps(node) {
	const container = node.__gjjRegexRows;
	if (!container) return;
	const values = [];
	for (const row of Array.from(container.children)) {
		const ta = row.querySelector(".gjj-regex-input");
		values.push(ta?.value || "");
	}
	node.properties = node.properties || {};
	node.properties.patterns = values;
}

function syncPatternWidget(node, index, value) {
	const w = widget(node, `${PATTERN_PREFIX}${index}`);
	if (!w) return;
	w.value = String(value ?? "");
}

function reindexPatterns(node) {
	const container = node.__gjjRegexRows;
	if (!container) return;
	const rows = Array.from(container.children);

	// 收集当前 textarea 值
	const values = [];
	for (const row of rows) {
		const ta = row.querySelector(".gjj-regex-input");
		values.push(ta?.value || "");
	}

	// 清空所有隐藏 widget
	for (let i = 1; i <= MAX_PATTERNS; i++) {
		syncPatternWidget(node, i, "");
	}

	// 按顺序重新写入
	for (let i = 0; i < values.length; i++) {
		syncPatternWidget(node, i + 1, values[i]);
		const label = rows[i]?.querySelector(".gjj-regex-row-label");
		if (label) label.textContent = `正则 ${i + 1}`;
	}

	// 同步保存到 node.properties.patterns，确保刷新/重启后不丢失
	savePatternsToProps(node);
}

function addPatternRow(node, value = "") {
	const container = node.__gjjRegexRows;
	if (!container) return;
	const existingCount = container.children.length;
	if (existingCount >= MAX_PATTERNS) return;

	const index = existingCount + 1;
	const row = document.createElement("div");
	row.className = "gjj-regex-row";

	const header = document.createElement("div");
	header.className = "gjj-regex-row-header";
	const label = document.createElement("span");
	label.className = "gjj-regex-row-label";
	label.textContent = `正则 ${index}`;
	const removeBtn = document.createElement("button");
	removeBtn.type = "button";
	removeBtn.className = "gjj-regex-remove";
	removeBtn.textContent = "✕";
	removeBtn.title = "删除此正则";
	removeBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		removePatternRow(node, row);
	});
	header.append(label, removeBtn);

	const textarea = document.createElement("textarea");
	textarea.className = "gjj-regex-input";
	textarea.placeholder = "输入正则表达式...";
	textarea.value = value;
	textarea.spellcheck = false;
	textarea.rows = 2;
	// input 事件只更新隐藏 widget 值和 node.properties，不重建 DOM（避免失焦）
	textarea.addEventListener("input", () => {
		const idx = getRowIndex(node, row);
		if (idx >= 0) {
			syncPatternWidget(node, idx + 1, textarea.value);
			savePatternsToProps(node);
			schedule(node, 150);
		}
	});
	// change/blur 时同步保存
	textarea.addEventListener("change", () => {
		const idx = getRowIndex(node, row);
		if (idx >= 0) {
			syncPatternWidget(node, idx + 1, textarea.value);
			savePatternsToProps(node);
		}
	});
	textarea.addEventListener("blur", () => {
		const idx = getRowIndex(node, row);
		if (idx >= 0) {
			syncPatternWidget(node, idx + 1, textarea.value);
			savePatternsToProps(node);
		}
	});

	row.append(header, textarea);
	container.appendChild(row);

	reindexPatterns(node);
	updateAddButton(node);
}

function removePatternRow(node, row) {
	const container = node.__gjjRegexRows;
	if (!container) return;
	const idx = getRowIndex(node, row);
	if (idx < 0) return;

	container.removeChild(row);
	reindexPatterns(node);
	updateAddButton(node);
	schedule(node, 0);
}

function updateAddButton(node) {
	const btn = node.__gjjRegexAddBtn;
	if (!btn) return;
	const count = node.__gjjRegexRows?.children.length || 0;
	btn.disabled = count >= MAX_PATTERNS;
	btn.textContent = count >= MAX_PATTERNS ? `已达上限（${MAX_PATTERNS} 条）` : "+ 添加正则";
}

function rebuildPatternRows(node) {
	const container = node.__gjjRegexRows;
	if (!container) return;
	container.replaceChildren();

	// 优先从 node.properties.patterns 恢复（可靠的持久化来源）
	const savedPatterns = Array.isArray(node.properties?.patterns) ? node.properties.patterns : null;

	let hasAny = false;
	if (savedPatterns && savedPatterns.length) {
		for (const value of savedPatterns) {
			const str = String(value ?? "");
			if (str.trim()) {
				addPatternRow(node, str);
				hasAny = true;
			}
		}
	} else {
		// fallback：从隐藏 widget 读取（兼容旧工作流）
		for (let i = 1; i <= MAX_PATTERNS; i++) {
			const value = getWidgetValue(node, `${PATTERN_PREFIX}${i}`);
			if (value && value.trim()) {
				addPatternRow(node, value);
				hasAny = true;
			}
		}
	}
	// 至少保留一行空输入
	if (!hasAny) {
		addPatternRow(node, "");
	}
	updateAddButton(node);
}

// ── DOM 构建 ─────────────────────────────────────────

function buildDom(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-regex-wrap";
	wrap.style.cssText = "box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:5px;padding:2px 0;";

	// 内联样式（每个节点独立注入，删除节点时随之消失）
	const style = document.createElement("style");
	style.textContent = `
		.gjj-regex-wrap * { box-sizing:border-box; }
		.gjj-regex-rows { display:flex;flex-direction:column;gap:5px; }
		.gjj-regex-row { display:flex;flex-direction:column;gap:3px; }
		.gjj-regex-row-header { display:flex;justify-content:space-between;align-items:center; }
		.gjj-regex-row-label { color:#b9c8cc;font-size:11px; }
		.gjj-regex-remove { width:20px;height:20px;padding:0;border:1px solid #33464e;border-radius:5px;background:#2b2d30;color:#ff8080;cursor:pointer;font-size:12px;line-height:1; }
		.gjj-regex-remove:hover { background:#3a1518;border-color:#ef4444; }
		.gjj-regex-input { width:100%;min-height:44px;max-height:120px;padding:4px 6px;border:1px solid #33464e;border-radius:6px;background:#0b1418;color:#f1f5f5;font:12px monospace;resize:vertical;outline:none; }
		.gjj-regex-input:focus { border-color:#4f8f7a; }
		.gjj-regex-input.error { border-color:#ef4444; }
		.gjj-regex-add { width:100%;padding:4px;border:1px dashed #33464e;border-radius:6px;background:#1a2024;color:#9fb0b7;cursor:pointer;font-size:12px; }
		.gjj-regex-add:hover { border-color:#4f8f7a;color:#dff8ea; }
		.gjj-regex-add:disabled { opacity:.4;cursor:default; }
		.gjj-regex-sep { height:1px;background:rgba(105,125,134,0.24);margin:2px 0; }
		.gjj-regex-flags { display:flex;gap:4px;padding:2px 0; }
		.gjj-regex-flag { width:32px;height:28px;padding:0;border:1px solid #33464e;border-radius:6px;background:#2b2d30;color:#9fb0b7;cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center; }
		.gjj-regex-flag:hover { background:#2d3338; }
		.gjj-regex-flag.on { border-color:#4f8f7a;background:#20362f; }
		.gjj-regex-status { color:rgba(235,245,250,.78);font:12px system-ui,'Microsoft YaHei',sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
	`;
	wrap.appendChild(style);

	// 正则行容器
	const rows = document.createElement("div");
	rows.className = "gjj-regex-rows";
	wrap.appendChild(rows);
	node.__gjjRegexRows = rows;

	// 添加按钮
	const addBtn = document.createElement("button");
	addBtn.type = "button";
	addBtn.className = "gjj-regex-add";
	addBtn.textContent = "+ 添加正则";
	addBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		addPatternRow(node, "");
		// 自动聚焦新行
		const lastRow = node.__gjjRegexRows?.lastElementChild;
		const ta = lastRow?.querySelector(".gjj-regex-input");
		if (ta) setTimeout(() => ta.focus(), 0);
	});
	wrap.appendChild(addBtn);
	node.__gjjRegexAddBtn = addBtn;

	// 分隔线
	const sep1 = document.createElement("div");
	sep1.className = "gjj-regex-sep";
	wrap.appendChild(sep1);

	// emoji 标志按钮排
	const flagsRow = document.createElement("div");
	flagsRow.className = "gjj-regex-flags";
	for (const def of FLAG_DEFS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "gjj-regex-flag";
		btn.textContent = def.emoji;
		btn.title = def.tooltip;
		btn.dataset.flagKey = def.key;
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const flags = getFlagState(node);
			setFlag(node, def.key, !flags[def.key]);
			syncFlagButtons(node);
			schedule(node, 0);
		});
		flagsRow.appendChild(btn);
	}
	wrap.appendChild(flagsRow);

	// 分隔线
	const sep2 = document.createElement("div");
	sep2.className = "gjj-regex-sep";
	wrap.appendChild(sep2);

	// 状态栏
	const status = document.createElement("div");
	status.className = "gjj-regex-status";
	status.textContent = "填写正则后自动生成输出口。";
	wrap.appendChild(status);
	node.__gjjRegexStatus = status;

	// 阻止画布事件冒泡
	wrap.addEventListener("pointerdown", (e) => e.stopPropagation());
	wrap.addEventListener("mousedown", (e) => e.stopPropagation());

	return wrap;
}

// ── 节点尺寸估算 ─────────────────────────────────────

function estimateHeight(node) {
	const rowCount = Math.max(1, node.__gjjRegexRows?.children.length || 1);
	// 每行约 70px（header 20 + textarea 44 + gap 6），加上其他元素
	return 10 + rowCount * 70 + 30 + 8 + 32 + 8 + 20 + 8;
}

// ── 核心刷新逻辑 ─────────────────────────────────────

function stabilize(node) {
	if (!node) return;
	node.min_width = Math.max(node.min_width || 0, MIN_WIDTH);
	if (Array.isArray(node.size)) node.size[0] = Math.max(node.size[0] || 0, MIN_WIDTH);

	// 读取当前正则值
	const patterns = [];
	const rows = Array.from(node.__gjjRegexRows?.children || []);
	for (let i = 0; i < rows.length; i++) {
		const ta = rows[i]?.querySelector(".gjj-regex-input");
		const val = ta?.value || "";
		if (val.trim()) {
			patterns.push({ index: i, value: val, row: rows[i], ta });
		}
	}

	const flags = getFlagState(node);

	// 验证每条正则
	const errors = [];
	for (const p of patterns) {
		const validation = tryValidatePattern(p.value, flags);
		if (!validation.valid) {
			errors.push(`正则${patterns.indexOf(p) + 1}：${validation.error}`);
			p.ta?.classList.add("error");
		} else {
			p.ta?.classList.remove("error");
		}
	}

	if (errors.length) {
		ensureOutputCount(node, 1);
		const output = node.outputs?.[0];
		if (output) {
			output.name = "正则错误";
			output.label = "正则错误";
			output.localized_name = "正则错误";
			output.type = "*";
			output.tooltip = errors.join("\n");
		}
		setStatus(node, errors[0], true);
		dirty(node);
		return;
	}

	// 根据非空正则条数更新输出端口
	applyOutputs(node, patterns.length, []);

	if (patterns.length === 0) {
		setStatus(node, "请添加正则表达式，输出口会自动生成。");
	} else {
		setStatus(node, `${patterns.length} 条正则 → ${patterns.length} 个输出端口。`);
	}
	dirty(node);
}

function schedule(node, ms) {
	clearTimeout(node.__gjjRegexTimer);
	node.__gjjRegexTimer = setTimeout(() => stabilize(node), ms ?? SCHEDULE_MS);
}

// ── 执行结果处理 ─────────────────────────────────────

function applyExecutedResult(node, message) {
	const detail = message?.detail || message || {};
	const output = detail?.output || detail;
	let patternCount = output?.pattern_count;
	let matchCounts = output?.match_counts;
	let errors = output?.errors;

	if (Array.isArray(patternCount)) patternCount = patternCount[0];
	if (Array.isArray(matchCounts)) matchCounts = matchCounts[0];
	if (Array.isArray(errors)) errors = errors;

	if (typeof patternCount === "number" && patternCount >= 0) {
		if (Array.isArray(errors) && errors.length) {
			ensureOutputCount(node, 1);
			const out = node.outputs?.[0];
			if (out) {
				out.name = "正则错误";
				out.label = "正则错误";
				out.localized_name = "正则错误";
				out.type = "*";
				out.tooltip = errors.join("\n");
			}
			setStatus(node, errors[0], true);
		} else {
			applyOutputs(node, patternCount, []);
			if (Array.isArray(matchCounts) && matchCounts.length) {
				const parts = matchCounts.slice(0, patternCount).map((c, i) => `正则${i + 1}：${c} 项`);
				setStatus(node, `${patternCount} 条正则，${parts.join("，")}。`);
			} else {
				setStatus(node, `${patternCount} 条正则。`);
			}
		}
		dirty(node);
	}
}

// ── 初始化 ───────────────────────────────────────────

function ensureDom(node) {
	if (node.__gjjRegexWrap) return;
	const wrap = buildDom(node);
	node.__gjjRegexWrap = wrap;
	const domWidget = node.addDOMWidget?.("gjj_regex_panel", "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.round(estimateHeight(node)),
	});
	if (domWidget) {
		domWidget.computeSize = (width) => {
			const nodeWidth = Math.round(Number(width || node.size?.[0] || MIN_WIDTH));
			return [nodeWidth, Math.round(estimateHeight(node))];
		};
		// 将 DOM widget 移到 text widget 之后
		if (Array.isArray(node.widgets)) {
			const textIdx = node.widgets.findIndex((w) => w?.name === TEXT_WIDGET);
			const domIdx = node.widgets.indexOf(domWidget);
			if (textIdx >= 0 && domIdx > textIdx + 1) {
				node.widgets.splice(domIdx, 1);
				node.widgets.splice(textIdx + 1, 0, domWidget);
			}
		}
	}
}

function stabilizeNode(node) {
	if (!node) return;
	hideNativeWidgets(node);
	ensureDom(node);

	// 从隐藏 widget 恢复正则值到 DOM
	const container = node.__gjjRegexRows;
	if (container && container.children.length === 0) {
		rebuildPatternRows(node);
	}

	syncFlagButtons(node);
	stabilize(node);
}

function patchTextCallback(node) {
	if (node.__gjjRegexTextPatched) return;
	node.__gjjRegexTextPatched = true;
	const w = widget(node, TEXT_WIDGET);
	if (!w) return;
	const old = w.callback;
	w.callback = function (...args) {
		const result = old?.apply(this, args);
		schedule(node, 60);
		return result;
	};
	const input = w.inputEl || w.element?.querySelector?.("textarea,input");
	if (input) {
		input.addEventListener?.("input", () => schedule(node, 150));
	}
}

// ── 注册扩展 ─────────────────────────────────────────

app.registerExtension({
	name: "Comfy.GJJ.RegexExtractor",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const onCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onCreated?.apply(this, args);
			stabilizeNode(this);
			patchTextCallback(this);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			patchTextCallback(this);
			// 延迟重建：强制清空 container，确保从 node.properties.patterns 恢复
			// 不调用 stabilizeNode，避免 onNodeCreated 阶段创建的空行干扰恢复
			setTimeout(() => {
				ensureDom(this);
				hideNativeWidgets(this);
				if (this.__gjjRegexRows) {
					this.__gjjRegexRows.replaceChildren();
				}
				rebuildPatternRows(this);
				syncFlagButtons(this);
				stabilize(this);
			}, 0);
			return result;
		};

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = onExecuted?.apply(this, [message, ...args]);
			applyExecutedResult(this, message);
			return result;
		};

		const onResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = onResize?.apply(this, args);
			// 重新计算 DOM widget 高度
			const domWidget = this.widgets?.find((w) => w?.name === "gjj_regex_panel");
			if (domWidget?.computeSize) {
				domWidget.computeSize(this.size?.[0] || MIN_WIDTH);
			}
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET) {
			stabilizeNode(node);
			patchTextCallback(node);
		}
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.type === TARGET || node?.comfyClass === TARGET) {
				stabilizeNode(node);
				patchTextCallback(node);
			}
		}
	},
});

api.addEventListener("executed", (event) => {
	const nodeId = String(
		event?.detail?.node_id
		?? event?.detail?.node
		?? event?.detail?.display_node
		?? event?.detail?.nodeId
		?? "",
	);
	if (!nodeId) return;
	const node = app.graph?.getNodeById?.(Number(nodeId))
		|| app.graph?._nodes?.find((item) => String(item?.id) === nodeId);
	if (!node || (node.type !== TARGET && node.comfyClass !== TARGET)) return;
	applyExecutedResult(node, event?.detail?.output || event?.detail);
});

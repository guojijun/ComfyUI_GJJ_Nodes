import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_PromptTemplateSelector";
const TEMPLATE_LIBRARY_WIDGET = "template_library";
const SELECTED_TEMPLATE_WIDGET = "selected_template";
const DOM_WIDGET = "gjj_prompt_template_selector_dom";
const STYLE_ID = "gjj-prompt-template-selector-style";
const DEFAULT_LIBRARY = `《清新家电横版商品广告》这是一张{{产品类型(加湿器)}}横版商品广告图，整体采用{{配色(白色、浅木色和清新绿色)}}配色，背景是{{背景场景(阳光充足的客厅或书房)}}，窗外和室内植物虚化成柔和光斑。桌面上摆放一台{{产品外观(白色圆柱形加湿器)}}，{{产品动态(顶部持续喷出白色细雾)}}。左侧主标题以大号{{标题字体颜色(深绿色粗体字)}}写着“{{主标题第一行(清新加湿，)}}”“{{主标题第二行(舒适每一天)}}”，副标题写着“{{副标题(为家注入清润空气，呵护全家健康呼吸)}}”，下方有细横线分隔。再下方四组图标与卖点文字依次为“{{卖点1标题(大容量补水)}}”“{{卖点1说明(持久加湿，无需频繁加水)}}”，“{{卖点2标题(静音运行)}}”“{{卖点2说明(低噪设计，安静不打扰)}}”，“{{卖点3标题(细腻雾化)}}”“{{卖点3说明(均匀细腻水雾，润泽每一寸空气)}}”，“{{卖点4标题(一键操作)}}”“{{卖点4说明(简单便捷，老人也能轻松使用)}}”。右侧产品机身正面印有品牌字样“{{品牌(Gezier)}}”，保留透明水位窗、电源按键和状态指示灯等细节。桌面旁边有{{辅助道具(透明玻璃杯、植物盆栽、白色书本和浅色器皿)}}。整体构图为左文右图，环境干净通透，强调{{核心属性(大容量补水、静音、细雾加湿和简单操作)}}的家用属性。
《个人彩妆诊断图卡》标题为“{{主标题(个人彩妆诊断图卡)}}”，带字幕“{{副标题(打造专属你的氛围感妆容)}}”。制作一张粉白色背景的平直设计信息图，顶部三列结构。左列标题为“{{左列标题(建议保留)}}”，展示6排{{保留产品类型(化妆产品照片)}}，每张照片有粉红色勾号、黑体标题和说明，内容依次为：{{保留清单(蜜桃色腮红：提气色神器，日常通勤必备；丝绒唇泥：高级哑光妆效，显白不挑皮；棕色眼线液笔：温柔自然，放大双眼；香槟色高光：点亮面部立体感；灰棕色眉笔：野生眉必备，自然持久；定妆喷雾：持妆一整天，水润不拔干)}}。中心柱放置{{人物主体(穿粉红色连衣裙、微笑的东亚女人)}}的大肖像，上方有粉红色标签分析框，写“{{分析标签(妆容风格：温婉千金；眼妆重点：奶茶色修容；面部氛围：柔和干净)}}”，并展示{{颜色样本(桃、玫瑰、灰褐色、可可色)}}色卡。右列上半部分标题为“{{右上标题(可闲置/可替换)}}”，列出{{替换清单(冷调芭比粉-显黑；蓝色珠光眼影-难驾驭；夸张假睫毛-妆感重；偏黄修容粉-易显脏)}}；右列下半部分标题为“{{右下标题(比较缺，建议补齐)}}”，用2x3栅格展示{{补齐清单(清透粉底液、腮红膏、大地色眼影盘、镜面唇釉、极细睫毛膏、散粉刷)}}。底部左侧显示“{{升级标题(妆容升级方向)}}”，包含3个look formula面板：{{升级方案(公式1：温柔通勤妆；公式2：元气约会妆；公式3：伪素颜白开水妆)}}。底部右侧显示“{{优先级标题(购买优先级)}}”，配粉红色化妆包图标和编号优先顺序：{{购买优先级(第一：底妆；第二：彩妆；第三：彩妆不在于多，而在于精)}}。整体清理、柔和、精致。
《发型分析信息图》标题为“{{主标题(发型分析/寻找最佳发型)}}”的信息图表海报，背景为{{背景色(灯光米色)}}。左上角是一张巨大的垂直照片，照片上是{{人物主体(年轻亚洲女性，穿浅蓝色丝绸衬衫，温柔微笑)}}。照片右侧有四个带图标和文本的属性：“{{属性1标题(面形状)}}”配“{{属性1内容(椭圆形)}}”，“{{属性2标题(头发纹理)}}”配“{{属性2内容(精细、轻微波纹)}}”，“{{属性3标题(头发体积)}}”配“{{属性3内容(中等)}}”，“{{属性4标题(关键点)}}”配“{{属性4内容(修饰颧骨)}}”。右上角是“{{最佳区域标题(最佳匹配)}}”部分，有2x3照片栅格，标记01-06，展示{{最佳发型(锁骨长发配窗帘刘海；下巴长内扣鲍勃；分层中长发配轻盈刘海；低凌乱发髻；侧分中长波浪；高马尾配柔软波纹)}}。中间是“{{备选区域标题(不错的选项)}}”，1x4照片栅格，标记07-10，展示{{备选发型(长直发钝刘海；半扎松散波纹；短精灵发；经典法国辫)}}。左下角是“{{不推荐标题(不推荐)}}”，1x3照片栅格，标记11-13，展示{{不推荐发型(厚重刘海遮眉；贴头皮中分直发；非常紧密的卷发)}}。右下角包含带复选标记的“{{提示标题(头发提示)}}”块，写{{提示内容(避免厚重造型产品；用圆梳在根部打造自然体积；每6-8周定期修剪)}}。整体是清理的界面设计风格。`;

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	const value = getWidget(node, name)?.value;
	return value == null || value === "" ? String(fallback ?? "") : String(value);
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = String(value ?? "");
	if (widget.inputEl) widget.inputEl.value = widget.value;
	if (widget.element && "value" in widget.element) widget.element.value = widget.value;
	try { widget.callback?.(widget.value); } catch (_) {}
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjPromptTemplateSelectorOriginal) {
		widget.__gjjPromptTemplateSelectorOriginal = {
			type: widget.type,
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			draw: widget.draw,
			mouse: widget.mouse,
		};
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden" };
	for (const el of [widget.inputEl, widget.element, widget.widget]) hideElement(el);
}

function hideInternalWidgets(node) {
	hideWidget(getWidget(node, TEMPLATE_LIBRARY_WIDGET));
	hideWidget(getWidget(node, SELECTED_TEMPLATE_WIDGET));
}

function normalizeText(value) {
	return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function cleanBody(lines) {
	const items = [...lines];
	while (items.length && !String(items[0]).trim()) items.shift();
	while (items.length && !String(items[items.length - 1]).trim()) items.pop();
	return items.join("\n").trim();
}

function parseTemplates(text) {
	const source = normalizeText(text) || DEFAULT_LIBRARY;
	const result = [];
	const matches = [...source.matchAll(/^《([^》\r\n]+)》/gm)];
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const next = matches[index + 1];
		const title = String(match[1] || "").trim();
		const bodyStart = Number(match.index || 0) + match[0].length;
		const bodyEnd = next ? Number(next.index || source.length) : source.length;
		const body = cleanBody(source.slice(bodyStart, bodyEnd).split("\n"));
		if (title && body) result.push({ title, body });
	}
	return result;
}

function templatesForNode(node) {
	return parseTemplates(getWidgetValue(node, TEMPLATE_LIBRARY_WIDGET, DEFAULT_LIBRARY));
}

function selectedTitle(node) {
	const selected = getWidgetValue(node, SELECTED_TEMPLATE_WIDGET, "").trim();
	const templates = templatesForNode(node);
	return templates.some((item) => item.title === selected) ? selected : (templates[0]?.title || "");
}

function selectedTemplateBody(node) {
	const title = selectedTitle(node);
	const templates = templatesForNode(node);
	return String(templates.find((item) => item.title === title)?.body || templates[0]?.body || "");
}

function notifyTemplateChanged(node) {
	try {
		window.dispatchEvent(new CustomEvent("gjj-prompt-template-selector-changed", {
			detail: { nodeId: node?.id },
		}));
	} catch (_) {}
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-prompt-template-selector{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;color:#dce7e2;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;}
.gjj-prompt-template-selector *{box-sizing:border-box;}
.gjj-prompt-template-selector-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;}
.gjj-prompt-template-selector-btn{height:24px;border:1px solid #465761;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer;padding:0 7px;font-size:11px;font-weight:700;white-space:nowrap;}
.gjj-prompt-template-selector-btn:hover{background:#27343b;border-color:#6aa6b8;}
.gjj-prompt-template-selector-btn.active{background:#15352d;border-color:#39d6a4;color:#d9fff2;}
.gjj-prompt-template-selector-count{font-size:11px;color:#8ea0a8;white-space:nowrap;}
.gjj-prompt-template-selector-panel{display:none;flex-direction:column;gap:6px;padding:6px;border:1px solid #33464e;border-radius:8px;background:#0d1519;}
.gjj-prompt-template-selector-textarea{width:100%;min-height:220px;resize:vertical;padding:7px 8px;border:1px solid #44565f;border-radius:7px;outline:none;background:#070f12;color:#dce7e2;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;}
.gjj-prompt-template-selector-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap;}
`;
	document.head.appendChild(style);
}

function refreshNode(node, force = false) {
	const root = node?.__gjjPromptTemplateSelectorRoot;
	const widget = node?.__gjjPromptTemplateSelectorDomWidget;
	if (widget && root) {
		widget.computeSize = (width) => [Math.max(260, Math.round(Number(width || node.size?.[0] || 320))), Math.max(34, Math.ceil(root.scrollHeight || 34) + 4)];
		widget.getHeight = () => Math.max(34, Math.ceil(root.scrollHeight || 34) + 4);
	}
	const width = Math.max(260, Math.round(Number(node?.size?.[0] || 320)));
	const height = Math.max(78, Math.ceil(root?.scrollHeight || 70) + 12);
	if (force || Math.abs(Number(node?.size?.[1] || 0) - height) > 2) {
		node?.setSize?.([width, height]);
	}
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function refreshButtons(node) {
	const wrap = node?.__gjjPromptTemplateSelectorButtons;
	if (!wrap) return;
	const templates = templatesForNode(node);
	let selected = selectedTitle(node);
	if (!getWidgetValue(node, SELECTED_TEMPLATE_WIDGET, "").trim() && selected) {
		setWidgetValue(node, SELECTED_TEMPLATE_WIDGET, selected);
	}
	wrap.replaceChildren();
	for (const entry of templates) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `gjj-prompt-template-selector-btn${entry.title === selected ? " active" : ""}`;
		button.textContent = entry.title;
		button.title = entry.body;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, SELECTED_TEMPLATE_WIDGET, entry.title);
			refreshButtons(node);
			notifyTemplateChanged(node);
		});
		wrap.appendChild(button);
	}
	const count = node.__gjjPromptTemplateSelectorCount;
	if (count) count.textContent = templates.length ? `${templates.length} 模板` : "未解析到模板";
	refreshNode(node);
}

function buildDom(node) {
	ensureStyles();
	const root = document.createElement("div");
	root.className = "gjj-prompt-template-selector";
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-prompt-template-selector-toolbar";
	const settings = document.createElement("button");
	settings.type = "button";
	settings.className = "gjj-prompt-template-selector-btn";
	settings.textContent = "⚙️设置";
	const buttons = document.createElement("div");
	buttons.className = "gjj-prompt-template-selector-toolbar";
	const count = document.createElement("span");
	count.className = "gjj-prompt-template-selector-count";
	toolbar.append(settings, buttons, count);

	const panel = document.createElement("div");
	panel.className = "gjj-prompt-template-selector-panel";
	const textarea = document.createElement("textarea");
	textarea.className = "gjj-prompt-template-selector-textarea";
	textarea.spellcheck = false;
	textarea.value = getWidgetValue(node, TEMPLATE_LIBRARY_WIDGET, DEFAULT_LIBRARY) || DEFAULT_LIBRARY;
	textarea.placeholder = "《模板名称》这里写可被 GJJ_TemplatePrompt 使用的 {{变量(默认值)}} 模板正文\n《另一个模板》下一行行首的《》才会被解析成按钮";
	const actions = document.createElement("div");
	actions.className = "gjj-prompt-template-selector-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "gjj-prompt-template-selector-btn";
	cancel.textContent = "取消";
	const ok = document.createElement("button");
	ok.type = "button";
	ok.className = "gjj-prompt-template-selector-btn active";
	ok.textContent = "确定";
	actions.append(cancel, ok);
	panel.append(textarea, actions);
	root.append(toolbar, panel);

	const stop = (event) => event.stopPropagation();
	for (const el of [root, toolbar, settings, buttons, count, panel, textarea, actions, cancel, ok]) {
		for (const name of ["pointerdown", "mousedown", "click", "keydown", "keyup", "wheel", "dblclick", "contextmenu"]) {
			el.addEventListener(name, stop);
		}
	}
	settings.addEventListener("click", (event) => {
		event.preventDefault();
		textarea.value = getWidgetValue(node, TEMPLATE_LIBRARY_WIDGET, DEFAULT_LIBRARY) || DEFAULT_LIBRARY;
		const open = panel.style.display !== "flex";
		panel.style.display = open ? "flex" : "none";
		refreshNode(node, true);
		if (open) setTimeout(() => textarea.focus(), 0);
	});
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		panel.style.display = "none";
		refreshNode(node, true);
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		setWidgetValue(node, TEMPLATE_LIBRARY_WIDGET, textarea.value || DEFAULT_LIBRARY);
		const templates = templatesForNode(node);
		const selected = selectedTitle(node);
		if (!templates.some((item) => item.title === selected) && templates[0]) {
			setWidgetValue(node, SELECTED_TEMPLATE_WIDGET, templates[0].title);
		}
		panel.style.display = "none";
		refreshButtons(node);
		refreshNode(node, true);
		notifyTemplateChanged(node);
	});

	node.__gjjPromptTemplateSelectorRoot = root;
	node.__gjjPromptTemplateSelectorButtons = buttons;
	node.__gjjPromptTemplateSelectorCount = count;
	return root;
}

function ensureDom(node) {
	if (!node || node.__gjjPromptTemplateSelectorDomWidget) return;
	const root = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(260, Math.round(Number(width || node.size?.[0] || 320))), Math.max(34, Math.ceil(root.scrollHeight || 34) + 4)];
		widget.getHeight = () => Math.max(34, Math.ceil(root.scrollHeight || 34) + 4);
		node.__gjjPromptTemplateSelectorDomWidget = widget;
	}
	refreshButtons(node);
}

function stabilizeNode(node) {
	if (!node) return;
	ensureDom(node);
	hideInternalWidgets(node);
	refreshButtons(node);
	refreshNode(node);
	notifyTemplateChanged(node);
}

app.registerExtension({
	name: "Comfy.GJJ.PromptTemplateSelector",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if ([TEMPLATE_LIBRARY_WIDGET, SELECTED_TEMPLATE_WIDGET].includes(name)) hideWidget(widget);
			return widget;
		};
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.type === TARGET_NODE || node?.comfyClass === TARGET_NODE) setTimeout(() => stabilizeNode(node), 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.type === TARGET_NODE || node?.comfyClass === TARGET_NODE) stabilizeNode(node);
		}
	},
});

globalThis.GJJ_PromptTemplateSelector = {
	parseTemplates,
	templatesForNode,
	selectedTitle,
	selectedTemplateBody,
};

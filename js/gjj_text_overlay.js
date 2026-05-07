/**
 * GJJ 文本图片叠加节点前端实现
 * 功能：
 * 1. 动态隐藏文字参数（当有水印输入时）
 * 2. 可视化位置编辑器（支持拖拽调整 X/Y 位置）
 * 3. 集成颜色选择器（文字颜色和描边颜色）- 使用浏览器原生颜色选择器
 */

import { app } from "../../../scripts/app.js";

app.registerExtension({
	name: "GJJ.TextOverlay",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		// 在节点注册前拦截
		if (nodeData.name !== "GJJ_TextOverlay") return;

		// 保存原始 onNodeCreated
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

		// 重写 onNodeCreated
		nodeType.prototype.onNodeCreated = function() {
			// 调用原始方法
			if (originalOnNodeCreated) {
				originalOnNodeCreated.apply(this, arguments);
			}

			// 延迟执行，等待 widgets 初始化完成
			setTimeout(() => {
				setupColorPickers(this);
			}, 50);
		};
	},

	async nodeCreated(node) {
		if (node.comfyClass !== "GJJ_TextOverlay") return;

		// 延迟执行，等待DOM布局完成
		setTimeout(() => {
			setupTextOverlayUI(node);
		}, 100);
	},
});

/**
 * 设置文本叠加UI（合并参数隐藏和可视化编辑器）
 */
function setupTextOverlayUI(node) {
	// 检查是否已经设置过
	if (node.__gjjTextOverlaySetup) return;
	node.__gjjTextOverlaySetup = true;

	// 1. 设置参数动态隐藏
	setupParameterVisibility(node);
	
	// 2. 设置可视化位置编辑器
	setupVisualEditor(node);
	
	// 3. 设置颜色选择器
	setupColorPickers(node);
}

/**
 * 设置参数动态隐藏
 */
function setupParameterVisibility(node) {
	// 文字相关参数列表
	const textWidgetNames = [
		'texts',
		'split_char',
		'indexes',
		'text_opacity',
		'direction',
		'spacing',
		'seed',
		'strip_empty',
		'font_path',
		'font_size',
		'color_hex',
		'stroke_color_hex',
		'use_stroke',
		'stroke_width',
	];

	// 水印相关参数列表
	const watermarkWidgetNames = [
		'watermark_image',
		'watermark_opacity',
		'watermark_width',
	];

	/**
	 * 更新参数显示状态
	 */
	function updateWidgetVisibility() {
		// 检查是否有水印输入
		const watermarkWidget = node.widgets?.find(w => w.name === 'watermark_image');
		const hasWatermark = watermarkWidget && watermarkWidget.value !== undefined && watermarkWidget.value !== null;
		
		// 获取所有 widgets
		const allWidgets = node.widgets || [];
		
		// 遍历所有 widgets，根据是否有水印输入来显示/隐藏
		allWidgets.forEach(widget => {
			// 跳过 watermark_image 本身
			if (widget.name === 'watermark_image') return;
			
			// 检查是否是文字相关参数
			const isTextWidget = textWidgetNames.includes(widget.name);
			const isWatermarkWidget = watermarkWidgetNames.includes(widget.name);
			
			if (hasWatermark) {
				// 有水印输入：隐藏文字参数，显示水印参数
				if (isTextWidget) {
					widget.hidden = true;
				} else if (isWatermarkWidget) {
					widget.hidden = false;
				}
			} else {
				// 无水印输入：显示文字参数，隐藏水印参数
				if (isTextWidget) {
					widget.hidden = false;
				} else if (isWatermarkWidget) {
					widget.hidden = true;
				}
			}
		});
		
		// 触发节点重绘
		node.setDirtyCanvas(true, true);
	}

	// 监听水印输入变化
	const watermarkWidget = node.widgets?.find(w => w.name === 'watermark_image');
	if (watermarkWidget) {
		// 监听 value 变化
		let lastValue = watermarkWidget.value;
		Object.defineProperty(watermarkWidget, 'value', {
			get() {
				return lastValue;
			},
			set(newValue) {
				lastValue = newValue;
				updateWidgetVisibility();
			}
		});
	}

	// 初始更新
	updateWidgetVisibility();
	
	// 定期检查（作为备用机制）
	const checkInterval = setInterval(() => {
		updateWidgetVisibility();
	}, 1000);
	
	// 清理定时器（当节点被删除时）
	const originalOnRemoved = node.onRemoved;
	node.onRemoved = function() {
		clearInterval(checkInterval);
		if (originalOnRemoved) {
			originalOnRemoved.call(this);
		}
	};
}

/**
 * 设置可视化位置编辑器
 */
function setupVisualEditor(node) {
	if (node.__gjjTextOverlayVisualSetup) return;
	node.__gjjTextOverlayVisualSetup = true;

	// 添加可视化编辑器DOM Widget
	const editorWidget = node.addDOMWidget(
		"gjj_position_editor",
		"位置可视化编辑",
		createEditorContainer(),
		{
			// 固定高度为 300px（正方形）
			getHeight: () => 300,
			hideOnZoom: false,
		}
	);

	// 保存引用
	node.__gjjPositionEditor = editorWidget;
	
	// 初始化编辑器
	initPositionEditor(node, editorWidget.element);
}

/**
 * 创建编辑器容器
 */
function createEditorContainer() {
	const container = document.createElement("div");
	container.style.cssText = `
		width: 100%;
		height: 100%;
		position: relative;
		overflow: hidden;
		background: #1a1a1a;
		border: 1px solid #444;
		border-radius: 4px;
		margin-top: 8px;
	`;
	return container;
}

/**
 * 初始化位置编辑器
 */
function initPositionEditor(node, container) {
	// 获取相关 widgets
	const widgets = node.widgets || [];
	const xWidget = widgets.find(w => w.name === "x");
	const yWidget = widgets.find(w => w.name === "y");
	
	if (!xWidget || !yWidget) {
		console.warn("[GJJ_TextOverlay] 未找到 X/Y 控件");
		return;
	}

	// 创建画布
	const canvas = document.createElement("canvas");
	canvas.style.cssText = `
		width: 100%;
		height: 100%;
		cursor: crosshair;
	`;
	container.appendChild(canvas);

	// 获取绘图上下文
	const ctx = canvas.getContext("2d");
	
	// 调整画布尺寸
	const resizeCanvas = () => {
		const rect = container.getBoundingClientRect();
		
		// 如果容器还没渲染，跳过
		if (rect.width === 0 || rect.height === 0) return;
		
		const size = rect.width; // 使用宽度作为基准
		
		// 设置画布尺寸为正方形（与宽度一致）
		canvas.width = size;
		canvas.height = size;
		
		// 通过 CSS 保持容器的宽高比为 1:1
		container.style.aspectRatio = '1 / 1';
		
		drawCanvas();
	};

	// 绘制画布
	let isDragging = false;
	let dragStartPos = { x: 0, y: 0 };

	const drawCanvas = () => {
		const width = canvas.width;
		const height = canvas.height;
		
		// 清空画布
		ctx.fillStyle = "#1a1a1a";
		ctx.fillRect(0, 0, width, height);

		// 绘制网格
		drawGrid(ctx, width, height);

		// 绘制十字准线
		const xVal = parseFloat(xWidget.value || 0.5);
		const yVal = parseFloat(yWidget.value || 0.5);
		
		const posX = resolvePosition(xVal, width);
		const posY = resolvePosition(yVal, height);

		// 绘制十字线
		ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
		ctx.lineWidth = 1;
		ctx.setLineDash([5, 5]);
		ctx.beginPath();
		ctx.moveTo(posX, 0);
		ctx.lineTo(posX, height);
		ctx.moveTo(0, posY);
		ctx.lineTo(width, posY);
		ctx.stroke();
		ctx.setLineDash([]);

		// 绘制中心点
		ctx.fillStyle = "#FFD700";
		ctx.beginPath();
		ctx.arc(posX, posY, 8, 0, Math.PI * 2);
		ctx.fill();
		
		// 绘制外圈
		ctx.strokeStyle = "#FFF";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(posX, posY, 12, 0, Math.PI * 2);
		ctx.stroke();

		// 绘制坐标文本
		ctx.fillStyle = "#FFF";
		ctx.font = "12px monospace";
		ctx.fillText(`X: ${xVal.toFixed(2)} | Y: ${yVal.toFixed(2)}`, 10, 20);
		ctx.fillText(`模式: ${xVal <= 1.0 ? '百分比' : '像素'}`, 10, 40);
	};

	// 绘制网格
	const drawGrid = (ctx, width, height) => {
		ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
		ctx.lineWidth = 1;

		// 垂直线（百分比标记）
		for (let i = 0; i <= 10; i++) {
			const x = (i / 10) * width;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
		}

		// 水平线（百分比标记）
		for (let i = 0; i <= 10; i++) {
			const y = (i / 10) * height;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}
	};

	// 解析位置值（百分比或像素）
	const resolvePosition = (value, size) => {
		const val = parseFloat(value);
		if (val >= 0 && val <= 1.0) {
			return val * size;
		}
		return Math.min(val, size);
	};

	// 鼠标交互
	canvas.addEventListener("mousedown", (e) => {
		isDragging = true;
		const rect = canvas.getBoundingClientRect();
		dragStartPos = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		};
	});

	canvas.addEventListener("mousemove", (e) => {
		if (!isDragging) return;
		
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		// 更新 widgets 值
		const width = canvas.width;
		const height = canvas.height;

		// 根据当前位置判断使用百分比还是像素
		const xPercent = x / width;
		const yPercent = y / height;

		// 默认使用百分比（0-1范围）
		xWidget.value = xPercent.toFixed(2);
		yWidget.value = yPercent.toFixed(2);

		// 触发同步
		if (xWidget.callback) xWidget.callback(xWidget.value);
		if (yWidget.callback) yWidget.callback(yWidget.value);

		drawCanvas();
	});

	canvas.addEventListener("mouseup", () => {
		isDragging = false;
	});

	canvas.addEventListener("mouseleave", () => {
		isDragging = false;
	});

	// 监听 widgets 变化
	const originalSetValue = xWidget.setValue || (() => {});
	xWidget.setValue = function(value) {
		originalSetValue.call(this, value);
		drawCanvas();
	};

	const originalYSetValue = yWidget.setValue || (() => {});
	yWidget.setValue = function(value) {
		originalYSetValue.call(this, value);
		drawCanvas();
	};

	// 初始绘制
	resizeCanvas();
	
	// 监听窗口尺寸变化
	window.addEventListener("resize", resizeCanvas);
}

/**
 * 设置颜色选择器（使用浏览器原生颜色选择器）
 */
function setupColorPickers(node) {
	if (node.__gjjColorPickersSetup) return;
	node.__gjjColorPickersSetup = true;

	// 需要替换为颜色选择器的 widget 名称
	const colorWidgetNames = ['color_hex', 'stroke_color_hex'];
	
	// 找到颜色相关的 widgets
	const colorWidgets = [];
	(node.widgets || []).forEach(widget => {
		if (colorWidgetNames.includes(widget.name)) {
			colorWidgets.push(widget);
		}
	});
	
	// 为每个颜色 widget 添加颜色选择器功能
	colorWidgets.forEach(widget => {
		if (!widget) return;
		
		// 保存原始值
		const originalValue = widget.value;
		
		// 标记为颜色选择器类型
		widget.type = "COLOR";
		
		// 重写绘制方法，显示颜色预览
		widget.draw = function(ctx, node, widgetWidth, widgetY, height) {
			const border = 3;
			const x = 10;
			const y = widgetY;
			const w = widgetWidth - 20;
			const h = height - 6;
			
			// 绘制背景
			ctx.fillStyle = '#000';
			ctx.fillRect(x, y, w, h);
			
			// 绘制颜色预览
			const color = this.value || '#000000';
			ctx.fillStyle = color;
			ctx.fillRect(x + border, y + border, w - border * 2, h - border * 2);
			
			// 绘制边框
			ctx.strokeStyle = '#555';
			ctx.lineWidth = 1;
			ctx.strokeRect(x, y, w, h);
			
			// 保存位置用于点击检测
			this.last_y = y;
		};
		
		// 鼠标点击事件 - 使用浏览器原生颜色选择器
		widget.mouse = function(e, pos, node) {
			if (e.type === 'pointerdown' || e.type === 'mousedown') {
				const rect = [this.last_y, this.last_y + 32];
				if (pos[1] > rect[0] && pos[1] < rect[1]) {
					// 创建原生颜色选择器
					const picker = document.createElement('input');
					picker.type = 'color';
					picker.value = this.value || '#000000';
					
					// 定位到屏幕外
					picker.style.position = 'absolute';
					picker.style.left = '-9999px';
					picker.style.top = '-9999px';
					
					document.body.appendChild(picker);
					
					// 监听颜色变化
					picker.addEventListener('change', () => {
						this.value = picker.value;
						node.graph._version++;
						node.setDirtyCanvas(true, true);
						
						// 触发回调
						if (this.callback) {
							this.callback(picker.value);
						}
						
						picker.remove();
					});
					
					// 触发点击
					picker.click();
				}
			}
		};
		
		// 设置 widget 尺寸
		widget.computeSize = function(width) {
			return [width, 32];
		};
		
		// 恢复原始值
		widget.value = originalValue;
	});
	
	// 触发重绘
	if (node.setDirtyCanvas) {
		node.setDirtyCanvas(true, true);
	}
}

/**
 * 注入全局样式
 */
function injectGlobalStyles() {
	if (document.getElementById("gjj-text-overlay-editor-styles")) return;

	const style = document.createElement("style");
	style.id = "gjj-text-overlay-editor-styles";
	style.textContent = `
		.gjj-position-editor-container {
			user-select: none;
		}
	`;

	document.head.appendChild(style);
}

// 注入样式
injectGlobalStyles();

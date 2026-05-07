/**
 * GJJ 色彩平衡节点前端实现
 * 功能：
 * 1. Canvas 彩色滑块（重写 widget.draw）
 * 2. 节点内预览图（直接绘制在 Canvas 上）
 */

import { app } from "../../../scripts/app.js";

const NODE_TYPE = "GJJ_ColorBalance";

// 颜色配置：[低值颜色, 中值颜色, 高值颜色]
const COLOR_WIDGETS = {
  shadows_red: ["#00ffff", "#777777", "#ff0000"],
  shadows_green: ["#ff00ff", "#777777", "#00ff00"],
  shadows_blue: ["#ffff00", "#777777", "#0000ff"],

  midtones_red: ["#00ffff", "#777777", "#ff0000"],
  midtones_green: ["#ff00ff", "#777777", "#00ff00"],
  midtones_blue: ["#ffff00", "#777777", "#0000ff"],

  highlights_red: ["#00ffff", "#777777", "#ff0000"],
  highlights_green: ["#ff00ff", "#777777", "#00ff00"],
  highlights_blue: ["#ffff00", "#777777", "#0000ff"],
};

const PREVIEW_HEIGHT = 190;
const PREVIEW_MARGIN = 12;

app.registerExtension({
  name: "GJJ.ColorBalance.CanvasUI",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    // 保存原始方法
    const originalCreated = nodeType.prototype.onNodeCreated;
    const originalExecuted = nodeType.prototype.onExecuted;
    const originalDrawBackground = nodeType.prototype.onDrawBackground;
    const originalComputeSize = nodeType.prototype.computeSize;

    // 节点创建时
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);

      // 延迟执行，等待 widgets 初始化
      setTimeout(() => {
        patchColorSliders(this);
        ensurePreviewSize(this);
        this.setDirtyCanvas(true, true);
      }, 50);
    };

    // 节点执行完成后
    nodeType.prototype.onExecuted = function (message) {
      originalExecuted?.apply(this, arguments);

      // 读取预览图（兼容两种格式）
      const preview =
        message?.preview_image?.[0] ||
        message?.ui?.preview_image?.[0];

      console.log("[GJJ ColorBalance] onExecuted 收到预览图数据:", preview ? "有数据" : "无数据");

      if (preview) {
        setPreviewImage(this, preview);
      }
    };

    // 计算节点尺寸
    nodeType.prototype.computeSize = function () {
      const size = originalComputeSize
        ? originalComputeSize.apply(this, arguments)
        : [this.size?.[0] || 240, this.size?.[1] || 200];

      // 如果有预览图，增加高度
      if (this.__gjjPreviewImage) {
        size[1] += PREVIEW_HEIGHT + PREVIEW_MARGIN;
      }

      return size;
    };

    // 绘制背景（包括预览图）
    nodeType.prototype.onDrawBackground = function (ctx) {
      originalDrawBackground?.apply(this, arguments);

      // 如果有预览图且节点未折叠
      if (!this.__gjjPreviewImage || this.flags?.collapsed) return;

      drawPreview(this, ctx);
    };
  },
});

/**
 * 为彩色滑块应用自定义绘制
 */
function patchColorSliders(node) {
  if (node.__gjjColorSlidersPatched) return;
  node.__gjjColorSlidersPatched = true;

  for (const widget of node.widgets || []) {
    if (!widget?.name) continue;

    const colors = COLOR_WIDGETS[widget.name];
    if (!colors) continue;

    patchSingleSlider(widget, colors);
  }
}

/**
 * 为单个滑块应用自定义绘制
 */
function patchSingleSlider(widget, colors) {
  // 保存原始 draw 方法
  widget.__gjjOriginalDraw = widget.draw;

  // 重写 draw 方法
  widget.draw = function (ctx, node, widgetWidth, y, widgetHeight) {
    const h = widgetHeight || 20;
    const value = Number(this.value ?? 0);
    const min = Number(this.options?.min ?? -100);
    const max = Number(this.options?.max ?? 100);

    const label = this.options?.display_name || this.label || this.name;
    const displayValue = Number.isFinite(value) ? value.toFixed(1) : String(this.value);

    const left = 12;
    const right = widgetWidth - 12;

    const textY = y + h * 0.68;

    ctx.save();

    // 绘制标签
    ctx.font = "12px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#b8c0cc";
    ctx.fillText(label, left, textY);

    // 绘制数值
    ctx.textAlign = "right";
    ctx.fillStyle = "#f0f3f6";
    ctx.fillText(displayValue, right - 6, textY);

    // 彩色滑条区域
    const valueTextWidth = 46;
    const trackW = 66;
    const trackH = 8;
    const trackX = right - valueTextWidth - trackW - 10;
    const trackY = y + Math.round((h - trackH) / 2);

    // 绘制滑条背景
    roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
    ctx.fillStyle = "#333";
    ctx.fill();

    // 绘制彩色渐变
    const grad = ctx.createLinearGradient(trackX, 0, trackX + trackW, 0);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(0.5, colors[1]);
    grad.addColorStop(1, colors[2]);

    ctx.save();
    roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.restore();

    // 绘制滑块圆点
    const t = clamp((value - min) / (max - min), 0, 1);
    const knobX = trackX + t * trackW;
    const knobY = trackY + trackH / 2;

    ctx.beginPath();
    ctx.arc(knobX, knobY, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#888";
    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.stroke();

    ctx.restore();
  };
}

/**
 * 设置预览图
 */
function setPreviewImage(node, src) {
  const img = new Image();

  img.onload = () => {
    console.log("[GJJ ColorBalance] 预览图加载成功");
    node.__gjjPreviewImage = img;
    ensurePreviewSize(node);
    node.setDirtyCanvas(true, true);
  };

  img.onerror = () => {
    console.error("[GJJ ColorBalance] 预览图加载失败:", src);
  };

  img.src = src;
}

/**
 * 确保节点尺寸足够显示预览图
 */
function ensurePreviewSize(node) {
  if (!node.__gjjPreviewImage) return;

  const size = node.computeSize();
  node.setSize([
    Math.max(node.size?.[0] || 240, 240),
    Math.max(node.size?.[1] || 200, size[1]),
  ]);
}

/**
 * 绘制预览图
 */
function drawPreview(node, ctx) {
  const img = node.__gjjPreviewImage;
  if (!img) return;

  const width = node.size[0];
  const height = node.size[1];

  // 计算预览区域
  const areaX = 12;
  const areaW = width - 24;
  const areaH = PREVIEW_HEIGHT;
  const areaY = height - areaH - 14;

  ctx.save();

  // 绘制分割线
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, areaY - 10);
  ctx.lineTo(width - 12, areaY - 10);
  ctx.stroke();

  // 绘制背景
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  roundRect(ctx, areaX, areaY, areaW, areaH, 8);
  ctx.fill();

  // 计算图像缩放
  const scale = Math.min(
    areaW / img.width,
    (areaH - 24) / img.height
  );

  const drawW = img.width * scale;
  const drawH = img.height * scale;

  const drawX = areaX + (areaW - drawW) / 2;
  const drawY = areaY + 8;

  // 绘制图像
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // 绘制尺寸文字
  ctx.font = "11px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#d8d8d8";
  ctx.fillText(`${img.width} × ${img.height}`, width / 2, areaY + areaH - 10);

  ctx.restore();
}

/**
 * 绘制圆角矩形
 */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * 限制值在范围内
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

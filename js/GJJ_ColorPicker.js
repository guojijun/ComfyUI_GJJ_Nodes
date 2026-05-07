/**
 * GJJ 通用颜色选择器
 * 提供可视化色彩选择功能
 */

class GJJ_ColorPicker {
    static currentPicker = null;

    static show(node, widget, currentValue, callback) {
        if (GJJ_ColorPicker.currentPicker) {
            GJJ_ColorPicker.currentPicker.close();
        }
        const picker = new GJJ_ColorPicker(node, widget, currentValue, callback);
        GJJ_ColorPicker.currentPicker = picker;
        picker.show();
    }

    constructor(node, widget, currentValue, callback) {
        this.node = node;
        this.widget = widget;
        this.callback = callback;
        this.currentColor = this.parseColor(currentValue || '#000000');
        this.hsv = this.rgbToHsv(this.currentColor);
        this.container = null;
        this.canvas = null;
        this.ctx = null;
        this.isDragging = false;
        this.draggingMode = null;
    }

    parseColor(color) {
        if (!color) return { r: 0, g: 0, b: 0, a: 255 };
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            if (hex.length === 6) {
                return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                    a: 255
                };
            } else if (hex.length === 8) {
                return {
                    r: parseInt(hex.slice(0, 2), 16),
                    g: parseInt(hex.slice(2, 4), 16),
                    b: parseInt(hex.slice(4, 6), 16),
                    a: parseInt(hex.slice(6, 8), 16)
                };
            }
        }
        return { r: 0, g: 0, b: 0, a: 255 };
    }

    rgbToHsv(rgb) {
        const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const diff = max - min;
        let h = 0, s = max === 0 ? 0 : diff / max, v = max;
        if (diff !== 0) {
            if (max === r) h = (g - b) / diff + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / diff + 2;
            else h = (r - g) / diff + 4;
            h /= 6;
        }
        return { h, s, v };
    }

    hsvToRgb(hsv) {
        const h = hsv.h, s = hsv.s, v = hsv.v;
        const i = Math.floor(h * 6), f = h * 6 - i;
        const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        let r, g, b;
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }
        return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }

    rgbToHex(rgb) {
        return '#' + [rgb.r, rgb.g, rgb.b].map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    rgbToRgbaString(rgb, alpha) {
        const alphaPercent = Math.round((alpha / 255) * 100);
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaPercent}%)`;
    }

    show() {
        this.container = document.createElement('div');
        this.container.className = 'gjj-color-picker';
        this.container.style.cssText = `
            position: absolute; z-index: 10000; background: #1a1a1a;
            border: 1px solid #444; border-radius: 8px; padding: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5); font-family: Arial, sans-serif; color: #fff;
        `;
        this.positionPicker();

        this.canvas = document.createElement('canvas');
        this.canvas.width = 200; this.canvas.height = 200;
        this.canvas.style.cssText = `cursor: crosshair; border-radius: 4px; display: block;`;
        this.ctx = this.canvas.getContext('2d');

        this.hueCanvas = document.createElement('canvas');
        this.hueCanvas.width = 200; this.hueCanvas.height = 20;
        this.hueCanvas.style.cssText = `cursor: crosshair; border-radius: 4px; display: block; margin-top: 8px;`;
        this.hueCtx = this.hueCanvas.getContext('2d');

        this.alphaCanvas = document.createElement('canvas');
        this.alphaCanvas.width = 200; this.alphaCanvas.height = 20;
        this.alphaCanvas.style.cssText = `cursor: crosshair; border-radius: 4px; display: block; margin-top: 8px;`;
        this.alphaCtx = this.alphaCanvas.getContext('2d');

        this.infoDiv = document.createElement('div');
        this.infoDiv.style.cssText = `margin-top: 12px; display: flex; flex-direction: column; gap: 6px;`;

        this.hexInput = document.createElement('input');
        this.hexInput.type = 'text';
        this.hexInput.value = this.rgbToHex(this.currentColor);
        this.hexInput.style.cssText = `background: #333; border: 1px solid #555; border-radius: 4px; padding: 4px 8px; color: #fff; font-size: 12px;`;
        this.hexInput.addEventListener('change', (e) => {
            const newColor = this.parseColor(e.target.value);
            if (newColor) {
                this.currentColor = newColor;
                this.hsv = this.rgbToHsv(newColor);
                this.draw(); this.updateInfo(); this.notifyChange();
            }
        });

        this.previewDiv = document.createElement('div');
        this.previewDiv.style.cssText = `width: 100%; height: 30px; border-radius: 4px; border: 1px solid #555;`;

        this.infoDiv.appendChild(this.previewDiv);
        this.infoDiv.appendChild(this.hexInput);
        this.container.appendChild(this.canvas);
        this.container.appendChild(this.hueCanvas);
        this.container.appendChild(this.alphaCanvas);
        this.container.appendChild(this.infoDiv);
        document.body.appendChild(this.container);

        this.bindEvents();
        this.draw();
        this.updateInfo();
    }

    positionPicker() {
        const rect = this.node._pos ? { left: this.node._pos[0], top: this.node._pos[1] } : { left: 100, top: 100 };
        this.container.style.left = (rect.left + 200) + 'px';
        this.container.style.top = rect.top + 'px';
    }

    bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this.onPanelMouseDown(e));
        this.hueCanvas.addEventListener('mousedown', (e) => this.onHueMouseDown(e));
        this.alphaCanvas.addEventListener('mousedown', (e) => this.onAlphaMouseDown(e));
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('mouseup', (e) => this.onMouseUp(e));
        document.addEventListener('mousedown', (e) => {
            if (!this.container.contains(e.target)) this.close();
        }, { once: true });
    }

    draw() {
        this.drawPanel();
        this.drawHueSlider();
        this.drawAlphaSlider();
    }

    drawPanel() {
        const ctx = this.ctx, width = this.canvas.width, height = this.canvas.height;
        const hueColor = this.hsvToRgb({ h: this.hsv.h, s: 1, v: 1 });
        const gradientH = ctx.createLinearGradient(0, 0, width, 0);
        gradientH.addColorStop(0, '#ffffff');
        gradientH.addColorStop(1, `rgb(${hueColor.r}, ${hueColor.g}, ${hueColor.b})`);
        ctx.fillStyle = gradientH;
        ctx.fillRect(0, 0, width, height);

        const gradientV = ctx.createLinearGradient(0, 0, 0, height);
        gradientV.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradientV.addColorStop(1, 'rgba(0, 0, 0, 1)');
        ctx.fillStyle = gradientV;
        ctx.fillRect(0, 0, width, height);

        this.drawSelector(ctx, this.hsv.s * width, (1 - this.hsv.v) * height);
    }

    drawHueSlider() {
        const ctx = this.hueCtx, width = this.hueCanvas.width, height = this.hueCanvas.height;
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        for (let i = 0; i <= 6; i++) {
            const hue = i / 6;
            const rgb = this.hsvToRgb({ h: hue, s: 1, v: 1 });
            gradient.addColorStop(i / 6, `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        const x = this.hsv.h * width;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, 0, 4, height);
    }

    drawAlphaSlider() {
        const ctx = this.alphaCtx, width = this.alphaCanvas.width, height = this.alphaCanvas.height;
        const gridSize = 8;
        for (let y = 0; y < height; y += gridSize) {
            for (let x = 0; x < width; x += gridSize) {
                ctx.fillStyle = ((x / gridSize + y / gridSize) % 2 === 0) ? '#ccc' : '#fff';
                ctx.fillRect(x, y, gridSize, gridSize);
            }
        }
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, `rgba(${this.currentColor.r}, ${this.currentColor.g}, ${this.currentColor.b}, 1)`);
        gradient.addColorStop(1, `rgba(${this.currentColor.r}, ${this.currentColor.g}, ${this.currentColor.b}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        const x = (this.currentColor.a / 255) * width;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, 0, 4, height);
    }

    drawSelector(ctx, x, y) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
    }

    updateInfo() {
        this.hexInput.value = this.rgbToHex(this.currentColor);
        this.previewDiv.style.background = this.rgbToRgbaString(this.currentColor, this.currentColor.a);
    }

    notifyChange() {
        const hexWithAlpha = this.rgbToHex(this.currentColor) + 
            Math.round((this.currentColor.a / 255) * 100).toString(16).padStart(2, '0');
        if (this.callback) this.callback(hexWithAlpha);
        if (this.widget) {
            this.widget.value = this.rgbToRgbaString(this.currentColor, this.currentColor.a);
            this.widget.callback?.(this.widget.value);
        }
        if (this.node) this.node.setDirtyCanvas(true, true);
    }

    close() {
        if (this.container) {
            document.body.removeChild(this.container);
            this.container = null;
        }
        GJJ_ColorPicker.currentPicker = null;
    }

    onPanelMouseDown(e) {
        this.isDragging = true;
        this.draggingMode = 'panel';
        this.updatePanelFromMouse(e);
        e.preventDefault();
    }

    onHueMouseDown(e) {
        this.isDragging = true;
        this.draggingMode = 'hue';
        this.updateHueFromMouse(e);
        e.preventDefault();
    }

    onAlphaMouseDown(e) {
        this.isDragging = true;
        this.draggingMode = 'alpha';
        this.updateAlphaFromMouse(e);
        e.preventDefault();
    }

    onMouseMove(e) {
        if (!this.isDragging) return;
        switch (this.draggingMode) {
            case 'panel': this.updatePanelFromMouse(e); break;
            case 'hue': this.updateHueFromMouse(e); break;
            case 'alpha': this.updateAlphaFromMouse(e); break;
        }
    }

    onMouseUp(e) {
        this.isDragging = false;
        this.draggingMode = null;
    }

    updatePanelFromMouse(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        this.hsv.s = x / rect.width;
        this.hsv.v = 1 - (y / rect.height);
        const rgb = this.hsvToRgb(this.hsv);
        this.currentColor.r = rgb.r;
        this.currentColor.g = rgb.g;
        this.currentColor.b = rgb.b;
        this.draw();
        this.updateInfo();
        this.notifyChange();
    }

    updateHueFromMouse(e) {
        const rect = this.hueCanvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        this.hsv.h = x / rect.width;
        const rgb = this.hsvToRgb(this.hsv);
        this.currentColor.r = rgb.r;
        this.currentColor.g = rgb.g;
        this.currentColor.b = rgb.b;
        this.draw();
        this.updateInfo();
        this.notifyChange();
    }

    updateAlphaFromMouse(e) {
        const rect = this.alphaCanvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        this.currentColor.a = Math.round((x / rect.width) * 255);
        this.draw();
        this.updateInfo();
        this.notifyChange();
    }

    close() {
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
        GJJ_ColorPicker.currentPicker = null;
    }
}

window.GJJ_ColorPicker = GJJ_ColorPicker;

// 自动注册到 ComfyUI 的 LiteGraph
if (typeof LiteGraph !== 'undefined') {
    LiteGraph.registerWidgetType('COLOR_PICKER', {
        draw: function(ctx, node, widgetWidth, widgetY, height) {
            const border = 3;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, widgetY, widgetWidth, height);
            const color = this.value || '#000000';
            ctx.fillStyle = color;
            ctx.fillRect(border, widgetY + border, widgetWidth - border * 2, height - border * 2);
            ctx.fillStyle = '#fff'; ctx.font = '12px Arial'; ctx.textAlign = 'center';
            ctx.fillText(color, widgetWidth * 0.5, widgetY + height * 0.5 + 4);
        },
        mouse: function(e, pos, node) {
            if (e.type === 'pointerdown' || e.type === 'mousedown') {
                // 简单的点击区域检测，假设高度为32
                const rect = [this.last_y, this.last_y + 32];
                if (pos[1] > rect[0] && pos[1] < rect[1]) {
                    GJJ_ColorPicker.show(node, this, this.value, (newColor) => {
                        this.value = newColor;
                    });
                }
            }
        },
        computeSize: function(width) { return [width, 32]; }
    });
}

console.log('[GJJ_ColorPicker] 颜色选择器已加载');

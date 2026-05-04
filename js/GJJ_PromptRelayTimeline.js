import { GJJ_Utils } from "./gjj_utils.js";
const { app } = window.comfyAPI.app;

const PALETTE = [
  "#4f8edc", "#e07b3a", "#5cb85c", "#d9534f", "#9b6cd6",
  "#a07060", "#e377c2", "#7f7f7f", "#c4c447", "#3fbac4",
];

const RULER_HEIGHT = 22;
const BLOCK_HEIGHT = 64;
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT;
const HANDLE_HIT_PX = 6;
const REORDER_THRESHOLD_PX = 6;
const MIN_SEGMENT_LENGTH = 1;
const HIDDEN_WIDGET_NAMES = ["timeline_data", "local_prompts", "segment_lengths"];

function hideWidget(w) {
  if (!w) return;
  if (!w.__gjjPromptRelayHiddenState) {
    w.__gjjPromptRelayHiddenState = {
      type: w.type,
      draw: w.draw,
      computeSize: w.computeSize,
    };
  }
  w.type = "hidden";
  w.hidden = true;
  w.draw = () => {};
  w.computeSize = () => [0, -4];
  if (w.inputEl?.style) w.inputEl.style.display = "none";
  if (w.element?.style) w.element.style.display = "none";
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function pickColor(existingColors) {
  // First palette color not currently in use; otherwise generate one via golden-angle hue
  // rotation so additional segments stay visually distinct without colliding with the palette.
  for (const c of PALETTE) if (!existingColors.has(c)) return c;
  const idx = existingColors.size;
  const hue = (idx * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 55%, 55%)`;
}

function defaultTimeline(maxFrames) {
  const half = Math.max(MIN_SEGMENT_LENGTH, Math.floor(maxFrames / 2));
  return {
    segments: [
      { prompt: "", length: half, color: PALETTE[0] },
      { prompt: "", length: Math.max(MIN_SEGMENT_LENGTH, maxFrames - half), color: PALETTE[1] },
    ],
  };
}

function parseInitial(jsonStr, maxFrames) {
  if (!jsonStr) return defaultTimeline(maxFrames);
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj?.segments) && obj.segments.length > 0) {
      return {
        segments: obj.segments.map((s, i) => ({
          prompt: typeof s.prompt === "string" ? s.prompt : "",
          length: Math.max(MIN_SEGMENT_LENGTH, parseInt(s.length, 10) || MIN_SEGMENT_LENGTH),
          // Backward compat: assign a stable color if missing.
          color: typeof s.color === "string" ? s.color : PALETTE[i % PALETTE.length],
        })),
      };
    }
  } catch (_) {}
  return defaultTimeline(maxFrames);
}

class TimelineEditor {
  constructor(node, container) {
    this.node = node;
    this.container = container;
    this.maxFramesWidget = node.widgets.find(w => w.name === "max_frames");
    this.fpsWidget = node.widgets.find(w => w.name === "fps");
    this.timeUnitsWidget = node.widgets.find(w => w.name === "time_units");
    this.timelineDataWidget = node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = node.widgets.find(w => w.name === "segment_lengths");

    this.timeline = parseInitial(this.timelineDataWidget?.value, this.getMaxFrames());
    this.selectedIndex = 0;
    this.hoverIndex = -1;
    this.hoverHandle = -1;
    this.dragHandle = -1;
    this.dragStart = null;
    this.reorder = null;  // { sourceIdx, targetIdx, startX, startY, active }
    this._settling = false;  // true between reorder release and animation convergence
    this._inputBaseline = null;  // length snapshot for revertible lengthInput edits
    this._textCommitTimer = null;  // debounce handle for textarea-driven commits
    // Per-segment displayed X (animated). Keyed by segment array index.
    this._displayedX = new Map();
    this._targetX = new Map();
    this._animRaf = null;

    this.buildDOM();
    this.bindEvents();
    this.syncWidgetsFromTimeline();
    this.updateUIFromSelection();
    this.render();
  }

  getMaxFrames() {
    return Math.max(1, parseInt(this.maxFramesWidget?.value, 10) || 1);
  }

  getFps() {
    const v = parseFloat(this.fpsWidget?.value);
    return Number.isFinite(v) && v > 0 ? v : 24;
  }

  isSecondsMode() {
    return this.timeUnitsWidget?.value === "秒" || this.timeUnitsWidget?.value === "seconds";
  }

  // Format an integer frame count for display in the current units. In seconds mode we show
  // a tidy decimal (trims trailing zeros) so 24-frame chunks render as "1s" not "1.00s".
  formatTime(frames) {
    if (!this.isSecondsMode()) return String(frames);
    const s = frames / this.getFps();
    return `${s.toFixed(2).replace(/\.?0+$/, "")}秒`;
  }

  // Length-suffix shown on each block. Frames mode adds an "f" suffix here (not in the
  // ruler) so block labels read as a duration, not a frame index.
  formatLength(frames) {
    return this.isSecondsMode() ? this.formatTime(frames) : `${frames}帧`;
  }

  buildDOM() {
    this.container.innerHTML = "";
    this.container.style.cssText = `
      display: flex; flex-direction: column; gap: 6px;
      padding: 6px 8px; box-sizing: border-box;
      font-family: sans-serif; font-size: 11px; color: #ddd;
      width: 100%; height: 100%;
    `;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = `
      width: 100%; height: ${CANVAS_HEIGHT}px;
      display: block; background: #1a1a1a; border-radius: 4px;
      cursor: default;
    `;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.textarea = document.createElement("textarea");
    this.textarea.placeholder = "点击上方片段后编辑该段提示词...";
    this.textarea.style.cssText = `
      width: 100%; min-height: 60px; flex: 1 1 auto;
      box-sizing: border-box; resize: none;
      background: #2a2a2a; color: #eee; border: 1px solid #444;
      border-radius: 4px; padding: 6px; font-family: inherit; font-size: 12px;
    `;
    this.container.appendChild(this.textarea);

    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; align-items: center;";

    const lengthLabel = document.createElement("label");
    lengthLabel.style.cssText = "display: flex; align-items: center; gap: 4px;";
    lengthLabel.textContent = "长度:";
    this.lengthInput = document.createElement("input");
    this.lengthInput.type = "number";
    this.lengthInput.style.cssText = `
      width: 70px; background: #2a2a2a; color: #eee;
      border: 1px solid #444; border-radius: 3px; padding: 2px 4px;
    `;
    lengthLabel.appendChild(this.lengthInput);
    row.appendChild(lengthLabel);

    this.totalLabel = document.createElement("span");
    this.totalLabel.style.cssText = "color: #888; margin-left: 4px;";
    row.appendChild(this.totalLabel);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    row.appendChild(spacer);

    this.addBtn = this.makeButton(
      "+ 添加",
      "添加一个新片段；如果时间轴已满，会从末尾片段借出长度。",
    );
    this.distributeBtn = this.makeButton(
      "均分",
      "将所有片段设置为相同长度，并填满时间轴总帧数。",
    );
    this.deleteBtn = this.makeButton(
      "删除",
      "删除当前选中的片段；只剩一个片段时不可删除。",
    );
    row.appendChild(this.addBtn);
    row.appendChild(this.distributeBtn);
    row.appendChild(this.deleteBtn);

    this.container.appendChild(row);
  }

  makeButton(label, tooltip) {
    const b = document.createElement("button");
    b.textContent = label;
    if (tooltip) b.title = tooltip;
    b.style.cssText = `
      background: #3a3a3a; color: #eee; border: 1px solid #555;
      border-radius: 3px; padding: 3px 10px; cursor: pointer; font-size: 11px;
    `;
    b.addEventListener("mouseenter", () => b.style.background = "#4a4a4a");
    b.addEventListener("mouseleave", () => b.style.background = "#3a3a3a");
    return b;
  }

  bindEvents() {
    // stopPropagation prevents LiteGraph from treating clicks as node-drag/zoom
    this.canvas.addEventListener("pointerdown", e => { e.stopPropagation(); this.onPointerDown(e); });
    this.canvas.addEventListener("pointermove", e => { e.stopPropagation(); this.onPointerMove(e); });
    this.canvas.addEventListener("pointerup", e => { e.stopPropagation(); this.onPointerUp(e); });
    this.canvas.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
    this.canvas.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    this.canvas.addEventListener("pointerleave", () => {
      if (this.dragHandle < 0) {
        this.hoverIndex = -1;
        this.hoverHandle = -1;
        this.canvas.style.cursor = "default";
        this.render();
      }
    });
    // Keep textarea scrolling/typing from zooming or hijacking the graph
    this.textarea.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    this.textarea.addEventListener("pointerdown", e => e.stopPropagation());
    this.lengthInput.addEventListener("pointerdown", e => e.stopPropagation());
    this.lengthInput.addEventListener("wheel", e => e.stopPropagation(), { passive: true });

    this.textarea.addEventListener("input", () => {
      const seg = this.timeline.segments[this.selectedIndex];
      if (!seg) return;
      seg.prompt = this.textarea.value;
      // Update local_prompts widget immediately so a workflow run picks up the latest text
      // even if the debounced commit hasn't fired yet.
      if (this.localPromptsWidget) {
        this.localPromptsWidget.value = this.timeline.segments.map(s => s.prompt).join(" | ");
      }
      this.render();
      // Debounce the heavier timeline_data JSON write.
      if (this._textCommitTimer) clearTimeout(this._textCommitTimer);
      this._textCommitTimer = setTimeout(() => {
        this._textCommitTimer = null;
        this.commit();
      }, 120);
    });
    this.textarea.addEventListener("blur", () => {
      if (this._textCommitTimer) {
        clearTimeout(this._textCommitTimer);
        this._textCommitTimer = null;
        this.commit();
      }
    });
    this.lengthInput.addEventListener("focus", () => { this._inputBaseline = null; });
    this.lengthInput.addEventListener("blur", () => { this._inputBaseline = null; });
    this.lengthInput.addEventListener("input", () => {
      const idx = this.selectedIndex;
      const seg = this.timeline.segments[idx];
      if (!seg) return;
      const raw = parseFloat(this.lengthInput.value);
      if (!Number.isFinite(raw)) return;
      // In seconds mode the user types seconds; convert to whole frames since the
      // backend pipeline is frame-based. Round so 0.5s @ 24fps → 12 frames.
      const frames = Math.max(
        MIN_SEGMENT_LENGTH,
        Math.round(this.isSecondsMode() ? raw * this.getFps() : raw),
      );
      // Snapshot pre-edit state on the first keystroke so 20→30→20 reverts cleanly.
      if (!this._inputBaseline) {
        this._inputBaseline = this.timeline.segments.map(s => s.length);
      }
      this._setLengthShifting(idx, frames, this._inputBaseline);
      this.commit();
      this.render();
      this.updateTotalLabel();
    });

    this.addBtn.addEventListener("click", () => this.addSegment());
    this.distributeBtn.addEventListener("click", () => this.distributeEvenly());
    this.deleteBtn.addEventListener("click", () => this.deleteSelected());

    if (this.maxFramesWidget) {
      const prev = this.maxFramesWidget.callback;
      this.maxFramesWidget.callback = (...args) => {
        prev?.apply(this.maxFramesWidget, args);
        this.trimToFit();
        this.commit();
        this.updateUIFromSelection();
        this.render();
      };
    }
    // fps and time_units only affect display — re-render and refresh the editable readouts
    // (length input, total label) so the active units stay in sync with the widget values.
    for (const w of [this.fpsWidget, this.timeUnitsWidget]) {
      if (!w) continue;
      const prev = w.callback;
      w.callback = (...args) => {
        prev?.apply(w, args);
        this.updateUIFromSelection();
        this.render();
      };
    }

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.container);
    this.resizeCanvas();
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // offsetWidth is the canvas's CSS pixel size (ignores LiteGraph's zoom transform);
    // getBoundingClientRect would return post-transform pixels and break hit-testing math.
    const w = Math.max(50, Math.floor(this.canvas.offsetWidth));
    this.canvas.width = w * dpr;
    this.canvas.height = CANVAS_HEIGHT * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssWidth = w;
    this.render();
  }

  // ─── Layout ───

  pxPerFrame() {
    return this._cssWidth / this.getMaxFrames();
  }

  // Layout: by default uses the visual (effective) order, which matches the natural array
  // order except during an active reorder, where the dragged segment previews at targetIdx.
  segmentRects(order) {
    const segs = this.timeline.segments;
    const ord = order ?? this._getEffectiveOrder();
    const ppf = this.pxPerFrame();
    const rects = [];
    let cursor = 0;
    for (let visualPos = 0; visualPos < ord.length; visualPos++) {
      const idx = ord[visualPos];
      const len = segs[idx].length;
      rects.push({ index: idx, visualPos, x: cursor * ppf, w: len * ppf, frameStart: cursor, frameEnd: cursor + len });
      cursor += len;
    }
    return rects;
  }

  _getEffectiveOrder() {
    const n = this.timeline.segments.length;
    const natural = Array.from({ length: n }, (_, i) => i);
    if (!this.reorder?.active || this.reorder.targetIdx === this.reorder.sourceIdx) return natural;
    const order = natural.filter(i => i !== this.reorder.sourceIdx);
    order.splice(this.reorder.targetIdx, 0, this.reorder.sourceIdx);
    return order;
  }

  // Pick the target slot whose source-slot center is closest to where the dragged block's
  // center is currently rendered. This makes swaps trigger based on the block's visible
  // overlap (not raw cursor position), so dragOffset and segment-size differences feel natural.
  _computeReorderTarget() {
    const ppf = this.pxPerFrame();
    const sourceIdx = this.reorder.sourceIdx;
    const sourceLen = this.timeline.segments[sourceIdx].length;
    const blockCenterFrame =
      (this.reorder.cursorX - this.reorder.dragOffsetPx) / ppf + sourceLen / 2;

    const others = [];
    for (let i = 0; i < this.timeline.segments.length; i++) {
      if (i !== sourceIdx) others.push(this.timeline.segments[i].length);
    }

    let bestTarget = 0;
    let bestDist = Infinity;
    let cum = 0;
    for (let target = 0; target <= others.length; target++) {
      const sourceCenter = cum + sourceLen / 2;
      const dist = Math.abs(blockCenterFrame - sourceCenter);
      if (dist < bestDist) { bestDist = dist; bestTarget = target; }
      if (target < others.length) cum += others[target];
    }
    return bestTarget;
  }

  hitBoundary(mx) {
    const rects = this.segmentRects();
    for (let i = 0; i < rects.length; i++) {
      const right = rects[i].x + rects[i].w;
      if (Math.abs(mx - right) <= HANDLE_HIT_PX) return i;
    }
    return -1;
  }

  hitBlock(mx, my) {
    if (my < RULER_HEIGHT) return -1;
    const rects = this.segmentRects();
    for (const r of rects) {
      if (mx >= r.x && mx < r.x + r.w) return r.index;
    }
    return -1;
  }

  // ─── Pointer ───

  onPointerDown(e) {
    const { x, y } = this.localPos(e);
    // Any new interaction interrupts a post-reorder settle animation.
    this._settling = false;
    const handle = this.hitBoundary(x);
    if (handle >= 0) {
      this.dragHandle = handle;
      const segs = this.timeline.segments;
      this.dragStart = {
        x,
        initialLengths: segs.map(s => s.length),
      };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const block = this.hitBlock(x, y);
    if (block >= 0) {
      this.selectedIndex = block;
      this.updateUIFromSelection();
      this.render();
      // dragOffsetPx = where inside the block we clicked, so the block follows the cursor at that offset.
      const sourceX = this._displayedX.get(block) ?? 0;
      this.reorder = {
        sourceIdx: block, targetIdx: block,
        startX: x, startY: y,
        cursorX: x,
        dragOffsetPx: x - sourceX,
        active: false,
      };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }

  onPointerMove(e) {
    const { x, y } = this.localPos(e);
    if (this.dragHandle >= 0) {
      const ppf = this.pxPerFrame();
      const dxFrames = Math.round((x - this.dragStart.x) / ppf);
      const handle = this.dragHandle;
      const initial = this.dragStart.initialLengths;
      this._setLengthShifting(handle, initial[handle] + dxFrames, initial);

      const segs = this.timeline.segments;
      this.commit();
      if (segs[this.selectedIndex]) this.lengthInput.value = this.lengthInputValueFor(segs[this.selectedIndex].length);
      this.updateTotalLabel();
      this.render();
      return;
    }

    if (this.reorder) {
      const dx = x - this.reorder.startX;
      const dy = y - this.reorder.startY;
      if (!this.reorder.active && Math.hypot(dx, dy) > REORDER_THRESHOLD_PX) {
        this.reorder.active = true;
        this.canvas.style.cursor = "grabbing";
      }
      if (this.reorder.active) {
        this.reorder.cursorX = x;
        this.reorder.targetIdx = this._computeReorderTarget();
        // Render every move so the dragged block tracks the cursor in real time.
        this.render();
        return;
      }
    }

    const handle = this.hitBoundary(x);
    const block = handle >= 0 ? -1 : this.hitBlock(x, y);
    if (handle !== this.hoverHandle || block !== this.hoverIndex) {
      this.hoverHandle = handle;
      this.hoverIndex = block;
      this.canvas.style.cursor = handle >= 0 ? "ew-resize" : (block >= 0 ? "pointer" : "default");
      this.render();
    }
  }

  onPointerUp(e) {
    if (this.dragHandle >= 0) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      this.dragHandle = -1;
      this.dragStart = null;
    }
    if (this.reorder) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (this.reorder.active) {
        this.canvas.style.cursor = "default";
        const { sourceIdx, targetIdx } = this.reorder;
        if (sourceIdx !== targetIdx) {
          // Remap displayed positions so segments visually stay where they were on release.
          // After splice, segment at new index `i` is timeline.segments[effectiveOrder[i]] (pre-splice).
          const effective = this._getEffectiveOrder();
          const oldDisplayed = new Map(this._displayedX);
          const seg = this.timeline.segments.splice(sourceIdx, 1)[0];
          this.timeline.segments.splice(targetIdx, 0, seg);
          this._displayedX = new Map();
          for (let newIdx = 0; newIdx < effective.length; newIdx++) {
            const oldIdx = effective[newIdx];
            if (oldDisplayed.has(oldIdx)) this._displayedX.set(newIdx, oldDisplayed.get(oldIdx));
          }
          this.selectedIndex = targetIdx;
          this.commit();
          this.updateUIFromSelection();
          this._settling = true;  // lerp the dragged block from cursor pos to its final slot
        }
      }
      this.reorder = null;
      this.render();
    }
  }

  localPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    // rect is post-CSS-transform; divide by the on-screen-to-CSS scale to get logical coords.
    const sx = (rect.width / this.canvas.offsetWidth) || 1;
    const sy = (rect.height / this.canvas.offsetHeight) || 1;
    return {
      x: (e.clientX - rect.left) / sx,
      y: (e.clientY - rect.top) / sy,
    };
  }

  // ─── Mutations ───

  addSegment() {
    const max = this.getMaxFrames();
    const n = this.timeline.segments.length;
    // Refuse only when truly impossible — every segment (incl. the new one) at MIN won't fit.
    if (max < (n + 1) * MIN_SEGMENT_LENGTH) return;

    const desired = Math.max(MIN_SEGMENT_LENGTH, Math.floor(max / (n + 1)));
    const newIdx = n;
    const usedColors = new Set(this.timeline.segments.map(s => s.color));
    this.timeline.segments.push({ prompt: "", length: desired, color: pickColor(usedColors) });
    this.trimToFit(newIdx);  // shrink other segments to fit; protect the new one

    // If still over (e.g., desired itself was too big), shrink the new one down to its slack.
    let total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    if (total > max) {
      this.timeline.segments[newIdx].length -= (total - max);
    }

    this.selectedIndex = newIdx;
    this.commit();
    this.updateUIFromSelection();
    this.updateTotalLabel();
    this.render();
  }

  // Max length segment `idx` can be without pushing total past max_frames.
  maxLengthFor(idx) {
    const max = this.getMaxFrames();
    let others = 0;
    for (let i = 0; i < this.timeline.segments.length; i++) {
      if (i !== idx) others += this.timeline.segments[i].length;
    }
    return Math.max(MIN_SEGMENT_LENGTH, max - others);
  }

  // Reset all lengths to `baseline`, set segment `idx` to `newLen`, then borrow from
  // subsequent segments (one at a time, down to MIN) if the total exceeds max_frames.
  // Used by both boundary drag and the length input so they share identical semantics.
  _setLengthShifting(idx, newLen, baseline) {
    const segs = this.timeline.segments;
    const max = this.getMaxFrames();
    for (let i = 0; i < segs.length; i++) segs[i].length = baseline[i];
    segs[idx].length = Math.max(MIN_SEGMENT_LENGTH, newLen);
    let total = segs.reduce((a, s) => a + s.length, 0);
    for (let i = idx + 1; i < segs.length && total > max; i++) {
      const reducible = segs[i].length - MIN_SEGMENT_LENGTH;
      const take = Math.min(reducible, total - max);
      segs[i].length -= take;
      total -= take;
    }
    if (total > max) segs[idx].length -= (total - max);
  }

  // Trim segments from the end (then second-to-last, etc.) until total fits max_frames.
  // protectIndex (optional): a segment to leave alone (e.g. the segment we just added).
  // Caller is responsible for committing afterward.
  trimToFit(protectIndex = -1) {
    const max = this.getMaxFrames();
    let total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    for (let i = this.timeline.segments.length - 1; i >= 0 && total > max; i--) {
      if (i === protectIndex) continue;
      const seg = this.timeline.segments[i];
      const reducible = seg.length - MIN_SEGMENT_LENGTH;
      const take = Math.min(reducible, total - max);
      seg.length -= take;
      total -= take;
    }
  }

  // Spread segment lengths evenly across max_frames; leftover frames go to the first segments
  // so the total exactly equals max_frames (when feasible).
  distributeEvenly() {
    const max = this.getMaxFrames();
    const n = this.timeline.segments.length;
    if (n === 0) return;
    const base = Math.max(MIN_SEGMENT_LENGTH, Math.floor(max / n));
    const remainder = Math.max(0, max - base * n);
    for (let i = 0; i < n; i++) {
      this.timeline.segments[i].length = base + (i < remainder ? 1 : 0);
    }
    this.commit();
    this.updateUIFromSelection();
    this.render();
  }

  deleteSelected() {
    if (this.timeline.segments.length <= 1) return;
    this.timeline.segments.splice(this.selectedIndex, 1);
    this.selectedIndex = clamp(this.selectedIndex, 0, this.timeline.segments.length - 1);
    this.commit();
    this.updateUIFromSelection();
    this.updateTotalLabel();
    this.render();
  }

  // ─── Persistence ───

  commit() {
    this.syncWidgetsFromTimeline();
    this.node.graph?.setDirtyCanvas?.(true, true);
  }

  syncWidgetsFromTimeline() {
    const segs = this.timeline.segments;
    if (this.timelineDataWidget) this.timelineDataWidget.value = JSON.stringify(this.timeline);
    if (this.localPromptsWidget) this.localPromptsWidget.value = segs.map(s => s.prompt).join(" | ");
    if (this.segmentLengthsWidget) this.segmentLengthsWidget.value = segs.map(s => s.length).join(", ");
  }

  // ─── UI sync ───

  // Value to put in the length <input> for a given frame count, formatted in active units.
  // Seconds mode shows up to 3 decimals (trimmed) so 1-frame steps are visible at any fps.
  lengthInputValueFor(frames) {
    if (!this.isSecondsMode()) return String(frames);
    return (frames / this.getFps()).toFixed(3).replace(/\.?0+$/, "");
  }

  updateUIFromSelection() {
    const seg = this.timeline.segments[this.selectedIndex];
    if (!seg) {
      this.textarea.value = "";
      this.lengthInput.value = "";
    } else {
      if (this.textarea.value !== seg.prompt) this.textarea.value = seg.prompt;
      this.lengthInput.value = this.lengthInputValueFor(seg.length);
    }
    // Step the input by 1 frame's worth so spinner clicks/arrow keys move sensibly in either mode.
    this.lengthInput.step = this.isSecondsMode() ? (1 / this.getFps()).toFixed(4) : "1";
    this.lengthInput.min = this.isSecondsMode() ? (MIN_SEGMENT_LENGTH / this.getFps()).toFixed(4) : MIN_SEGMENT_LENGTH;
    // Programmatic value change invalidates any in-progress baseline.
    this._inputBaseline = null;
    this.updateTotalLabel();
  }

  updateTotalLabel() {
    const total = this.timeline.segments.reduce((a, s) => a + s.length, 0);
    const max = this.getMaxFrames();
    if (this.isSecondsMode()) {
      const fps = this.getFps();
      const fmt = (f) => (f / fps).toFixed(2).replace(/\.?0+$/, "");
      this.totalLabel.textContent = `合计: ${fmt(total)} / ${fmt(max)} 秒 @ ${fps}fps`;
    } else {
      this.totalLabel.textContent = `合计: ${total} / ${max} 帧`;
    }
  }

  // ─── Render ───

  render() {
    // Compute target X for each segment from the effective (preview) order.
    const rects = this.segmentRects();
    this._targetX = new Map();
    for (const r of rects) this._targetX.set(r.index, r.x);

    if (this.reorder?.active) {
      // The dragged segment follows the cursor in real time (no lerp). Other segments
      // lerp toward their preview-order slots.
      const sourceIdx = this.reorder.sourceIdx;
      const sourcePos = this.reorder.cursorX - this.reorder.dragOffsetPx;
      this._targetX.set(sourceIdx, sourcePos);
      this._displayedX.set(sourceIdx, sourcePos);
      this._kickAnim();
    } else if (this._settling) {
      // Post-release: lerp displayed positions toward their final slots without snapping.
      this._kickAnim();
    } else {
      // All other state changes (boundary drag, add/delete, length input, resize) snap.
      for (const [idx, target] of this._targetX) this._displayedX.set(idx, target);
      this._draw();
    }
  }

  _kickAnim() {
    if (this._animRaf) return;
    this._animRaf = requestAnimationFrame(() => this._tick());
  }

  _tick() {
    this._animRaf = null;
    let needsMore = false;
    const speed = 0.15;
    for (const [idx, target] of this._targetX) {
      const cur = this._displayedX.get(idx);
      if (cur === undefined) { this._displayedX.set(idx, target); continue; }
      const diff = target - cur;
      if (Math.abs(diff) < 0.3) {
        this._displayedX.set(idx, target);
      } else {
        this._displayedX.set(idx, cur + diff * speed);
        needsMore = true;
      }
    }
    this._draw();
    // Keep ticking only while there's lerp work to do — render() will re-kick when targets change.
    if (needsMore) {
      this._animRaf = requestAnimationFrame(() => this._tick());
    } else if (!this.reorder?.active) {
      // Animation has converged and no reorder is in progress — clear settling flag.
      this._settling = false;
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this._cssWidth;
    ctx.clearRect(0, 0, w, CANVAS_HEIGHT);
    this.drawRuler(ctx, w);
    this.drawSegments(ctx, w);
  }

  drawRuler(ctx, w) {
    const max = this.getMaxFrames();
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);

    const ppf = this.pxPerFrame();
    const targetLabelSpacing = 60;

    // Pick a tick step. Seconds-mode chooses a "nice" duration in seconds and converts to
    // frames so ticks land on whole-second boundaries when fps is integer; frames-mode
    // uses the original frame-count nice list.
    let step;
    if (this.isSecondsMode()) {
      const fps = this.getFps();
      const target = targetLabelSpacing / (ppf * fps);
      const nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      let chosen = nice[nice.length - 1];
      for (const s of nice) { if (s >= target) { chosen = s; break; } }
      step = Math.max(1, Math.round(chosen * fps));
    } else {
      step = Math.max(1, Math.round(targetLabelSpacing / ppf));
      const niceSteps = [1, 2, 4, 5, 8, 10, 16, 20, 25, 50, 100];
      for (const s of niceSteps) { if (s >= step) { step = s; break; } }
    }

    ctx.strokeStyle = "#444";
    ctx.fillStyle = "#aaa";
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "top";
    ctx.lineWidth = 1;

    for (let f = 0; f <= max; f += step) {
      const x = Math.floor(f * ppf) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(this.formatTime(f), x + 2, 2);
    }
    // Final tick at max if not aligned
    const xMax = Math.floor(max * ppf) - 0.5;
    ctx.strokeStyle = "#666";
    ctx.beginPath();
    ctx.moveTo(xMax, 0);
    ctx.lineTo(xMax, RULER_HEIGHT);
    ctx.stroke();
  }

  drawSegments(ctx, w) {
    const rects = this.segmentRects();
    const blockY = RULER_HEIGHT + 2;
    const blockH = BLOCK_HEIGHT - 4;

    // Empty timeline background
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, blockY, w, blockH);

    // Render in two passes so the dragged segment is on top during reorder.
    const dragIdx = this.reorder?.active ? this.reorder.sourceIdx : -1;
    const rendered = [...rects].sort((a, b) => (a.index === dragIdx ? 1 : 0) - (b.index === dragIdx ? 1 : 0));

    for (const r of rendered) {
      const seg = this.timeline.segments[r.index];
      const color = seg.color || PALETTE[r.index % PALETTE.length];
      const isSelected = r.index === this.selectedIndex;
      const isHover = r.index === this.hoverIndex;
      const isDragging = r.index === dragIdx;

      const drawX = Math.floor(this._displayedX.get(r.index) ?? r.x);
      const drawW = Math.max(2, Math.floor(r.w));

      ctx.fillStyle = color;
      ctx.globalAlpha = isDragging ? 0.9 : (isSelected ? 1.0 : (isHover ? 0.9 : 0.75));
      ctx.fillRect(drawX, blockY, drawW, blockH);
      ctx.globalAlpha = 1.0;

      ctx.strokeStyle = isDragging ? "#ffd54f" : (isSelected ? "#fff" : "rgba(0,0,0,0.4)");
      ctx.lineWidth = isDragging || isSelected ? 2 : 1;
      ctx.strokeRect(drawX + 0.5, blockY + 0.5, drawW - 1, blockH - 1);

      // Label: prompt (wrapped to 2 lines) + frame range
      ctx.fillStyle = "#fff";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      const label = seg.prompt || `(片段 ${r.index + 1})`;
      const [line1, line2] = this.wrapTwoLines(ctx, label, drawW - 8);
      ctx.fillText(line1, drawX + 4, blockY + 4);
      if (line2) ctx.fillText(line2, drawX + 4, blockY + 18);

      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "10px monospace";
      const range = `${this.formatTime(r.frameStart)}–${this.formatTime(r.frameEnd)} (${this.formatLength(seg.length)})`;
      const rangeTrunc = this.truncateText(ctx, range, drawW - 8);
      ctx.fillText(rangeTrunc, drawX + 4, blockY + blockH - 14);
    }

    // Boundary handles (visible cue) — hidden during reorder since they're not interactive then.
    if (!this.reorder?.active) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const drawX = this._displayedX.get(r.index) ?? r.x;
        const right = Math.floor(drawX + r.w);
        const isHover = i === this.hoverHandle || i === this.dragHandle;
        ctx.fillStyle = isHover ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.fillRect(right - 1, blockY + 4, 2, blockH - 8);
      }
    }
  }

  truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + "…" : "";
  }

  // Greedy word wrap to at most two lines; line 2 ellipsizes if it still overflows.
  wrapTwoLines(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return [text, ""];

    const tokens = text.split(/(\s+)/);  // alternating words and whitespace
    let line1 = "";
    let consumed = 0;
    for (let i = 0; i < tokens.length; i++) {
      const candidate = line1 + tokens[i];
      if (ctx.measureText(candidate).width > maxWidth) break;
      line1 = candidate;
      consumed = i + 1;
    }

    // First word is wider than maxWidth — fall back to char-level ellipsis on one line.
    if (!line1.trim()) return [this.truncateText(ctx, text, maxWidth), ""];

    let line2 = tokens.slice(consumed).join("").trim();
    if (!line2) return [line1.trimEnd(), ""];
    if (ctx.measureText(line2).width > maxWidth) {
      line2 = this.truncateText(ctx, line2, maxWidth);
    }
    return [line1.trimEnd(), line2];
  }

  destroy() {
    this.resizeObserver?.disconnect();
    if (this._animRaf) cancelAnimationFrame(this._animRaf);
    if (this._textCommitTimer) {
      clearTimeout(this._textCommitTimer);
      this._textCommitTimer = null;
      // Best-effort flush so an in-flight prompt edit doesn't disappear if the user
      // removes the node mid-typing (commit is a no-op if widgets are gone).
      try { this.commit(); } catch (_) {}
    }
  }
}

// Workflows saved before fps/time_units existed restore with a shorter widgets_values
// array, leaving the new widgets at null / "". ComfyUI's input validator then rejects ""
// for the Float fps input — restore schema defaults on configure.
const APPENDED_WIDGET_DEFAULTS = [["fps", 24.0], ["time_units", "帧"]];

app.registerExtension({
  name: "GJJ.PromptRelay.Timeline",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "GJJ_PromptRelayEncodeTimeline") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this.title = "GJJ · 🧭 时间轴提示词编码";
      this.properties = this.properties || {};
      this.properties.gjj_prompt_relay_timeline = true;

      for (const name of HIDDEN_WIDGET_NAMES) {
        hideWidget(this.widgets.find(w => w.name === name));
      }

      const container = document.createElement("div");
      this._timelineWidget = this.addDOMWidget("gjj_prompt_relay_timeline", "GJJPromptRelayTimeline", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 220,
        getHeight: () => 220,
      });

      // Defer construction until widgets are settled (configure runs after onNodeCreated for saved nodes)
      const self = this;
      setTimeout(() => {
        try {
          self._timelineEditor = new TimelineEditor(self, container);
        } catch (err) {
          console.error("[GJJ PromptRelay] 时间轴编辑器初始化失败:", err);
        }
      }, 0);

      const onRemoved = this.onRemoved;
      this.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        const out = onConfigure?.apply(this, arguments);
        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }
        // Rebuild from restored widget values
        setTimeout(() => {
          if (this._timelineEditor) {
            this._timelineEditor.timeline = parseInitial(
              this._timelineEditor.timelineDataWidget?.value,
              this._timelineEditor.getMaxFrames(),
            );
            this._timelineEditor.selectedIndex = clamp(
              this._timelineEditor.selectedIndex, 0,
              this._timelineEditor.timeline.segments.length - 1,
            );
            this._timelineEditor.updateUIFromSelection();
            this._timelineEditor.render();
          }
        }, 10);
        return out;
      };

      return r;
    };
  },
});

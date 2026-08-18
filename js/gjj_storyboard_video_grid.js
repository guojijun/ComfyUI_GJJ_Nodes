import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { gjjCharacterThumbnailPath, gjjSceneThumbnailPath, loadGjjLibraryThumbnailBlobUrl } from "./gjj_library_thumbnails.js";
import { gjjTempImagePreviewItem, gjjTempImageOriginalItem, loadGjjPreviewBlobUrl, ensureGjjTempImagePreview, preloadGjjFullImage } from "./gjj_temp_image_preview.js";
import { bindGjjMediaDrag } from "./gjj_media_drag.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_StoryboardVideoGrid";
    const PANEL_WIDGET = "storyboard_video_grid_panel";
    const TABLE_WIDGET = "storyboard_table";
    const SINGLE_CELL_INDEX_INPUT = "single_cell_index";
    const SINGLE_CELL_TOTAL_INPUT = "single_cell_total";
    const SELECTED_CELL_INDICES_INPUT = "selected_cell_indices";
    const FULL_TABLE_INPUT = "storyboard_full_table";
    const FORCE_GENERATE_INPUT = "force_generate_all";
    const PREVIEW_IMAGES_INPUT = "storyboard_preview_images";
    const REMEMBERED_TABLE_LINK_PROP = "gjj_storyboard_video_grid_remembered_table_link_v1";
    const TABLE_SIGNATURE_PROP = "gjj_storyboard_video_grid_table_signature_v1";
    const KEYFRAME_LAYOUT_VERSION = "role_asset_reference_only_v4";
    const KEYFRAME_LAYOUT_VERSION_PROP = "gjj_storyboard_video_grid_keyframe_layout_version_v1";

    // 解析表格文本 → 分镜数组
    function parseTable(text) {
        const lines = String(text || "")
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map(l => l.trim())
            .filter(l => l && !l.startsWith("#"));
        const allShots = lines.map((line, i) => {
            // 支持 || 和 | 两种分隔符（优先 ||）
            let parts;
            if (line.includes("||")) {
                parts = line.split("||");
            } else if (line.includes("|")) {
                parts = line.split("|");
            } else {
                // 没有分隔符，整行作为关键帧提示词
                parts = [String(i + 1), line, "", ""];
            }
            // 补齐到 4 段
            while (parts.length < 4) parts.push("");
            const index = /^\d+$/.test((parts[0] || "").trim()) ? parseInt(parts[0].trim(), 10) : i + 1;
            return {
                index,
                keyframe_prompt: (parts[1] || "").trim(),
                video_prompt: (parts[2] || "").trim(),
                // 第 4 段之后都视为对白。这样单格内可以继续用 ||
                // 分隔多段“@角色：台词”，不会只保留第一段。
                dialogue_text: parts.slice(3).join("||").trim(),
            };
        });
        // 过滤空 shot 后，重新分配 cellId（0-based 顺序编号）
        const validShots = allShots.filter(s => s.keyframe_prompt || s.video_prompt || s.dialogue_text);
        validShots.forEach((s, i) => { s.cellId = i; });
        return validShots;
    }

    // 把分镜数组序列化为表格文本
    function serializeTable(shots) {
        return shots.map((s, i) => {
            return `${s.index}||${s.keyframe_prompt}||${s.video_prompt}||${s.dialogue_text}`;
        }).join("\n");
    }

    const MIN_SHOT_DURATION_SECONDS = 4;

    function alignedSegmentFrames(duration, frameRate = 24) {
        const fps = Math.max(0.000001, Number(frameRate) || 24);
        const safeDuration = Math.max(MIN_SHOT_DURATION_SECONDS, Number(duration) || 0);
        return Math.max(5, Math.round(safeDuration * fps))
            + (5 - (Math.max(5, Math.round(safeDuration * fps)) % 17)) % 17;
    }

    function alignedSegmentDuration(duration, frameRate = 24) {
        const fps = Math.max(0.000001, Number(frameRate) || 24);
        return alignedSegmentFrames(duration, fps) / fps;
    }

    // 估算台词时长；每个子分镜最低 4 秒，并对齐到 MiniMax H3 的 17n+5 帧。
    function estimateDuration(dialogueText, charsPerSecond = 3, maxShotDuration = 15, frameRate = 24, videoPrompt = "") {
        if (!dialogueText) {
            const explicit = String(videoPrompt || "").match(/(?<!\d)(\d+(?:\.\d+)?)\s*秒/);
            const duration = explicit
                ? Math.min(Math.max(MIN_SHOT_DURATION_SECONDS, Number(maxShotDuration) || 15), Math.max(MIN_SHOT_DURATION_SECONDS, Number(explicit[1]) || 0))
                : MIN_SHOT_DURATION_SECONDS;
            return alignedSegmentDuration(duration, frameRate);
        }
        const matches = Array.from(String(dialogueText).matchAll(
            /@[^\s:：,，。.！!？?|]+\s*[:：]\s*([\s\S]*?)(?=(?:\s*\|\|\s*)?@[^\s:：,，。.！!？?|]+\s*[:：]|$)/g
        ));
        const speechDurations = [];
        for (const m of matches) {
            const text = String(m[1] || "");
            const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
            const english = (text.match(/[a-zA-Z]+/g) || []).length;
            speechDurations.push(Math.max(
                1,
                (chinese + english * 2) / Math.max(0.5, charsPerSecond) + 0.8,
            ));
        }
        if (!speechDurations.length) return alignedSegmentDuration(MIN_SHOT_DURATION_SECONDS, frameRate);
        const limit = Math.max(MIN_SHOT_DURATION_SECONDS, Number(maxShotDuration) || 15);
        const cameraTail = 0.75;
        const combined = speechDurations.reduce((sum, value) => sum + value, 0) + cameraTail;
        if (combined <= limit) return alignedSegmentDuration(combined, frameRate);
        let total = 0;
        let group = 0;
        for (const duration of speechDurations) {
            if (group > 0 && group + duration + cameraTail > limit) {
                total += alignedSegmentDuration(Math.min(limit, Math.max(MIN_SHOT_DURATION_SECONDS, group + cameraTail)), frameRate);
                group = 0;
            }
            group += duration;
        }
        if (group > 0) total += alignedSegmentDuration(Math.min(limit, Math.max(MIN_SHOT_DURATION_SECONDS, group + cameraTail)), frameRate);
        return total;
    }

    function widgetValue(node, name, fallback = "") {
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) return fallback;
        // 优先 widget.value（因为 disabled 的 element 可能读不到值）
        if (w.value !== undefined && w.value !== null) return w.value;
        // fallback：读 element
        if (w.element && "value" in w.element) {
            return w.element.value ?? fallback;
        }
        return fallback;
    }

    function setWidgetValue(node, name, value) {
        const w = node.widgets?.find((x) => x.name === name);
        if (w) {
            w.value = value;
            // 如果 element 存在且未被禁用，同步更新
            if (w.element && !w.element.disabled && "value" in w.element) {
                w.element.value = value;
            }
            // 不主动触发 callback，避免死循环
        }
    }

    function storyboardTableIsConnected(node) {
        const input = node?.inputs?.find?.((item) => item?.name === TABLE_WIDGET);
        return input?.link != null;
    }

    function graphLinkById(graph, linkId) {
        const links = graph?.links || graph?._links;
        if (links instanceof Map) return links.get(linkId) || links.get(String(linkId)) || null;
        return links?.[linkId] || links?.[String(linkId)] || null;
    }

    function tableInputIndex(node) {
        return node?.inputs?.findIndex?.((item) => item?.name === TABLE_WIDGET) ?? -1;
    }

    function syncUpstreamLinkButton(node) {
        const button = node?.__gjjSvgPanel?.linkBtn;
        if (!button) return;
        const linked = storyboardTableIsConnected(node);
        const remembered = node?.properties?.[REMEMBERED_TABLE_LINK_PROP];
        button.style.display = linked || remembered ? "inline-flex" : "none";
        button.textContent = linked ? "🔗" : "⛓️‍💥";
        button.classList.toggle("active", !linked && Boolean(remembered));
        button.title = linked
            ? "记住并断开分镜表格的上游节点"
            : "恢复之前记住的分镜表格上游节点";
    }

    function toggleUpstreamTableLink(node) {
        const inputIndex = tableInputIndex(node);
        if (inputIndex < 0) return;
        node.properties ||= {};
        const input = node.inputs?.[inputIndex];
        if (input?.link != null) {
            const link = graphLinkById(node.graph || app.graph, input.link);
            if (link) {
                node.properties[REMEMBERED_TABLE_LINK_PROP] = {
                    origin_id: link.origin_id,
                    origin_slot: link.origin_slot,
                };
            }
            node.disconnectInput?.(inputIndex);
        } else {
            const saved = node.properties[REMEMBERED_TABLE_LINK_PROP];
            const source = (node.graph || app.graph)?.getNodeById?.(saved?.origin_id);
            if (saved && source?.connect) {
                source.connect(Number(saved.origin_slot) || 0, node, inputIndex);
            }
        }
        node.graph?.change?.();
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
        syncUpstreamLinkButton(node);
    }

    function storyboardTableSnapshot(node) {
        // 有上游连接时，队列中的 storyboard_table 才是本次执行的最新值。
        // 留空快照可避免本地 widget 残留的上一次内容覆盖上游新结果。
        if (storyboardTableIsConnected(node)) return "";
        return String(widgetValue(node, TABLE_WIDGET) || "");
    }

    function markChanged(node) {
        const graph = node?.graph || app.graph;
        if (graph && typeof graph.change === "function") graph.change();
        if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
        if (app.graph && typeof app.graph.setDirtyCanvas === "function") {
            app.graph.setDirtyCanvas(true, true);
        }
    }

    function scheduleCompactEmptyNode(node) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const state = node?.__gjjSvgPanel;
            if (!state || Number(state.totalCells) > 0 || cachedPreviewItems(node).length) return;
            const videos = node?.properties?.gjj_storyboard_video_grid_cached_videos_v1;
            if (videos && typeof videos === "object" && Object.keys(videos).length) return;
            const computed = typeof node.computeSize === "function" ? node.computeSize() : null;
            const width = Math.max(320, Number(node.size?.[0]) || Number(computed?.[0]) || 440);
            const height = Math.max(100, Number(computed?.[1]) || 100);
            node.setSize?.([width, height]);
            node.setDirtyCanvas?.(true, true);
        }));
    }

    function scheduleExpandNodeForPreview(node) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const computed = typeof node?.computeSize === "function" ? node.computeSize() : null;
            const requiredHeight = Number(computed?.[1]) || 0;
            if (requiredHeight <= Number(node?.size?.[1] || 0)) return;
            node.setSize?.([Math.max(320, Number(node.size?.[0]) || Number(computed?.[0]) || 440), requiredHeight]);
            node.setDirtyCanvas?.(true, true);
        }));
    }

    function enforceSingleVideoOutput(node) {
        if (!Array.isArray(node?.outputs)) return;
        while (node.outputs.length > 1) {
            const index = node.outputs.length - 1;
            if (typeof node.removeOutput === "function") node.removeOutput(index);
            else node.outputs.splice(index, 1);
        }
        if (node.outputs[0]) {
            node.outputs[0].name = "视频合并输出";
            node.outputs[0].type = "VIDEO";
        }
    }

    function showNodeProgress(node, message, progress = null) {
        const state = node?.__gjjSvgPanel;
        if (!state?.progressPanel) return;
        if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
        state.progressPanel.style.display = "flex";
        state.progressText.textContent = String(message || "正在处理…");
        state.lastProgressMessage = String(message || "正在处理…").replace(/\s*·\s*步骤\s*\d+\/\d+.*$/u, "");
        const numeric = Number(progress);
        if (Number.isFinite(numeric) && numeric > 0) {
            const percent = Math.max(0, Math.min(100, numeric * 100));
            state.progressPercent.textContent = `${Math.round(percent)}%`;
            state.progressFill.classList.remove("indeterminate");
            state.progressFill.style.transform = "none";
            state.progressFill.style.width = `${Math.max(2, percent)}%`;
        } else {
            state.progressPercent.textContent = "";
            state.progressFill.style.width = "30%";
            state.progressFill.classList.add("indeterminate");
        }
    }

    function hideNodeProgress(node, delay = 900) {
        const state = node?.__gjjSvgPanel;
        if (!state?.progressPanel) return;
        if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
        state.progressHideTimer = setTimeout(() => {
            state.progressPanel.style.display = "none";
            state.progressFill.classList.remove("indeterminate");
            state.progressHideTimer = null;
        }, Math.max(0, Number(delay) || 0));
    }

    function buildSizeFloat(node) {
        const float = createFloatShell("📐 尺寸", "gjj-svg-size-float");
        const body = document.createElement("div");
        body.style.cssText = "display:flex;flex-direction:column;gap:8px;";
        const makeGrid = (columns) => {
            const row = document.createElement("div");
            row.style.cssText = `display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:5px;`;
            return row;
        };
        const makeButton = (label, handler) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gjj-svg-btn";
            button.textContent = label;
            button.style.cssText += "min-width:0;height:38px;font-size:12px;";
            button.addEventListener("click", handler);
            return button;
        };
        const normalize = (raw, fallback) => {
            const value = Math.max(352, Math.min(1920, Number(raw) || fallback));
            return Math.max(352, Math.round(value / 32) * 32);
        };
        const applySize = (width, height) => {
            const resolvedWidth = normalize(width, 1024);
            const resolvedHeight = normalize(height, 768);
            setWidgetValue(node, "width", resolvedWidth);
            setWidgetValue(node, "height", resolvedHeight);
            node.properties = node.properties || {};
            // Store an explicit named copy as well as the native hidden
            // widgets. This survives legacy positional widgets_values loading.
            node.properties.gjj_svg_width = resolvedWidth;
            node.properties.gjj_svg_height = resolvedHeight;
            node.properties.gjj_svg_size_mode = "画板尺寸";
            sync();
            markChanged(node);
        };

        const modeRow = makeGrid(2);
        const canvasButton = makeButton("画板尺寸", () => {
            node.properties = node.properties || {};
            node.properties.gjj_svg_size_mode = "画板尺寸";
            sync();
            markChanged(node);
        });
        const mpButton = makeButton("百万像素", () => {
            node.properties = node.properties || {};
            node.properties.gjj_svg_size_mode = "百万像素";
            sync();
            markChanged(node);
        });
        modeRow.append(canvasButton, mpButton);

        const dimensions = document.createElement("div");
        dimensions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;";
        const dimensionInputs = {};
        for (const [name, label, fallback] of [["width", "宽度", 1024], ["height", "高度", 768]]) {
            const field = document.createElement("label");
            field.style.cssText = "display:flex;align-items:center;gap:6px;color:#aac0c8;font:12px system-ui;";
            const caption = document.createElement("span");
            caption.textContent = label;
            const input = document.createElement("input");
            input.type = "number"; input.min = "352"; input.max = "1920"; input.step = "32";
            input.style.cssText = "min-width:0;width:100%;padding:7px;border:1px solid #3a4a50;border-radius:5px;background:#0a1216;color:#eef5f5;";
            input.addEventListener("change", () => applySize(
                name === "width" ? input.value : dimensionInputs.width.value,
                name === "height" ? input.value : dimensionInputs.height.value,
            ));
            field.append(caption, input); dimensions.appendChild(field); dimensionInputs[name] = input;
        }

        const ratios = [["21:9", 21, 9], ["16:9", 16, 9], ["4:3", 4, 3], ["3:2", 3, 2], ["1:1", 1, 1], ["2:3", 2, 3], ["3:4", 3, 4], ["9:16", 9, 16]];
        const ratioRow = makeGrid(8);
        const ratioButtons = ratios.map(([label, rw, rh]) => {
            const button = makeButton(label, () => {
                node.properties = node.properties || {};
                node.properties.gjj_svg_size_ratio = label;
                const mp = Math.max(0.2, Math.min(2, Number(node.properties.gjj_svg_size_mp) || 0.8));
                const pixels = mp * 1024 * 1024;
                applySize(Math.sqrt(pixels * rw / rh), Math.sqrt(pixels * rh / rw));
                node.properties.gjj_svg_size_mode = "百万像素";
                sync();
            });
            button.style.height = "34px"; button.style.padding = "2px";
            ratioRow.appendChild(button); return button;
        });

        const mpRow = document.createElement("label");
        mpRow.style.cssText = "display:grid;grid-template-columns:58px 1fr 72px;gap:8px;align-items:center;color:#aac0c8;";
        const mpCaption = document.createElement("span"); mpCaption.textContent = "📐 MP";
        const mpRange = document.createElement("input"); mpRange.type = "range"; mpRange.min = "0.2"; mpRange.max = "2"; mpRange.step = "0.1";
        const mpNumber = document.createElement("input"); mpNumber.type = "number"; mpNumber.min = "0.2"; mpNumber.max = "2"; mpNumber.step = "0.1";
        mpNumber.style.cssText = "width:100%;padding:6px;border:1px solid #3a4a50;border-radius:5px;background:#0a1216;color:#eef5f5;";
        const applyMp = (raw) => {
            node.properties = node.properties || {};
            node.properties.gjj_svg_size_mp = Math.round(Math.max(0.2, Math.min(2, Number(raw) || 0.8)) * 10) / 10;
            node.properties.gjj_svg_size_mode = "百万像素";
            const [rw, rh] = String(node.properties.gjj_svg_size_ratio || "4:3").split(":").map(Number);
            const pixels = node.properties.gjj_svg_size_mp * 1024 * 1024;
            applySize(Math.sqrt(pixels * rw / rh), Math.sqrt(pixels * rh / rw));
            node.properties.gjj_svg_size_mode = "百万像素";
            sync();
        };
        mpRange.addEventListener("input", () => applyMp(mpRange.value));
        mpNumber.addEventListener("change", () => applyMp(mpNumber.value));
        mpRow.append(mpCaption, mpRange, mpNumber);
        const result = document.createElement("div");
        result.style.cssText = "padding:10px;text-align:center;border:1px solid #31515a;border-radius:6px;color:#86e0ce;font-weight:700;";

        const sync = () => {
            node.properties = node.properties || {};
            const mode = String(node.properties.gjj_svg_size_mode || "画板尺寸");
            const ratio = String(node.properties.gjj_svg_size_ratio || "4:3");
            const mp = Math.max(0.2, Math.min(2, Number(node.properties.gjj_svg_size_mp) || 0.8));
            canvasButton.classList.toggle("active", mode === "画板尺寸");
            mpButton.classList.toggle("active", mode === "百万像素");
            ratioButtons.forEach((button, index) => button.classList.toggle("active", ratios[index][0] === ratio));
            dimensionInputs.width.value = String(normalize(widgetValue(node, "width", 1024), 1024));
            dimensionInputs.height.value = String(normalize(widgetValue(node, "height", 768), 768));
            mpRange.value = mpNumber.value = String(mp);
            result.textContent = `实际尺寸：${dimensionInputs.width.value} × ${dimensionInputs.height.value}`;
        };
        node.properties = node.properties || {};
        // Migrate the old video-oriented 0.4 MP default.  Existing workflows
        // otherwise keep generating soft 864x480 images after the backend
        // default has been corrected to StoryboardGridGenerator's 1024x768.
        const storedMp = Number(node.properties.gjj_svg_size_mp);
        const oldDefaultSize = Number(widgetValue(node, "width", 1024)) === 864
            && Number(widgetValue(node, "height", 768)) === 480;
        if (oldDefaultSize && (!Number.isFinite(storedMp) || storedMp <= 0.4)) {
            node.properties.gjj_svg_size_mp = 0.8;
            node.properties.gjj_svg_size_ratio = "4:3";
            node.properties.gjj_svg_size_mode = "画板尺寸";
            setWidgetValue(node, "width", 1024);
            setWidgetValue(node, "height", 768);
            node.properties.gjj_svg_width = 1024;
            node.properties.gjj_svg_height = 768;
        }
        body.append(modeRow, dimensions, ratioRow, mpRow, result);
        float.appendChild(body); sync();
        return float;
    }

    function buildRunFloat(node) {
        const float = createFloatShell("▶️ 生成", "gjj-svg-run-float");
        const actions = document.createElement("div");
        actions.style.cssText = "display:grid;grid-template-columns:1fr;gap:7px;";
        const addAction = (label, title, handler) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gjj-svg-btn";
            button.textContent = label;
            button.title = title;
            button.style.cssText += "width:100%;height:38px;justify-content:flex-start;padding:0 12px;";
            button.addEventListener("click", async () => {
                closeAllFloats(node);
                await handler();
            });
            actions.appendChild(button);
        };
        addAction("🖼️ 生成全部图片", "按 Qwen2511 参考逻辑生成全部首帧", () => generateAll(node, "keyframe_only"));
        addAction("♻️ 重生选中图片", "只重新生成当前选中的单元格图片", () => {
            const indices = getSelectedIndices(node);
            return indices.length ? regenerateCells(node, indices) : Promise.resolve();
        });
        addAction("🎬 生成全部分镜视频", "以每格首帧作为参考，按 MiniMax-H3 官方格式生成视频", () => generateAll(node, "video_only"));
        addAction("▶️ 生成全部图片和视频", "先生成全部首帧，再逐格生成 MiniMax-H3 参考视频", () => generateAll(node, "all"));
        float.appendChild(actions);
        return float;
    }

    // @引用解析正则（与 storyboard_grid_generator 保持一致）
    const AT_REF_RE = /@([0-9A-Za-z\u4e00-\u9fff._-]+)(?:\/([0-9A-Za-z\u4e00-\u9fff._-]+))?/g;
    const SCENE_REF_RE = /(?:🏕️?|🏞️?|🌄️?|🌆️?)([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[\\/]([0-9A-Za-z\u4e00-\u9fff._-]+))?|\[([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[\\/]([0-9A-Za-z\u4e00-\u9fff._-]+))?\]/g;

    // ====== 角色/场景引用（和 GJJ_StoryboardGridGenerator 完全一致） ======
    function apiMediaUrl(url) {
        const text = String(url || "").trim();
        if (!text) return "";
        if (/^(?:https?:|data:|blob:)/i.test(text)) return text;
        // ComfyUI 原生接口 /view 不需要 /api 前缀，只加 rand 防缓存
        const sep = text.includes("?") ? "&" : "?";
        return `${text}${sep}rand=${Date.now()}`;
    }

    // ===== Canvas 封面图 + 点击放大查看（参考 GJJ_StoryboardGridGenerator） =====
    function storyboardPreviewImageUrl(item, useThumbnail = false, cacheBust = "") {
        if (!item?.filename && !item?.original_filename) return "";
        const target = useThumbnail ? gjjTempImagePreviewItem(item) : gjjTempImageOriginalItem(item);
        const filename = String(target?.filename || "");
        const type = String(target?.type || "temp");
        const subfolder = String(target?.subfolder || "");
        const bust = cacheBust ? `&gjj_repair=${encodeURIComponent(cacheBust)}` : "";
        const path = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${bust}`;
        return api?.apiURL ? api.apiURL(path) : path;
    }

    function storyboardVideoUrl(item, fallback = "") {
        if (item?.filename) {
            const path = `/view?filename=${encodeURIComponent(String(item.filename))}&type=${encodeURIComponent(String(item.type || "output"))}&subfolder=${encodeURIComponent(String(item.subfolder || ""))}`;
            return apiMediaUrl(api?.apiURL ? api.apiURL(path) : path);
        }
        const raw = String(item?.url || fallback || "").trim();
        if (!raw) return "";
        return apiMediaUrl(raw);
    }

    function openCellVideoPlayer(url, cellNumber = 1) {
        if (!url) return;
        const overlay = document.createElement("div");
        overlay.className = "gjj-svg-video-overlay";
        const player = document.createElement("video");
        player.className = "gjj-svg-video-player";
        player.src = url;
        player.controls = true;
        player.autoplay = true;
        player.playsInline = true;
        player.muted = false;
        const title = document.createElement("div");
        title.className = "gjj-svg-video-player-title";
        title.textContent = `分镜 ${Math.max(1, Number(cellNumber) || 1)} · 视频预览`;
        const close = () => {
            player.pause();
            player.removeAttribute("src");
            player.load();
            overlay.remove();
            document.removeEventListener("keydown", onKeydown, true);
        };
        const onKeydown = (event) => { if (event.key === "Escape") close(); };
        overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
        document.addEventListener("keydown", onKeydown, true);
        overlay.append(player, title);
        document.body.appendChild(overlay);
        player.play().catch(() => {});
    }

    function drawImageCover(ctx, image, left, top, width, height, bleedScale = 1) {
        const sourceW = Math.max(1, image.naturalWidth || image.width || 1);
        const sourceH = Math.max(1, image.naturalHeight || image.height || 1);
        const scale = Math.max(width / sourceW, height / sourceH) * Math.max(1, Number(bleedScale) || 1);
        const drawW = sourceW * scale;
        const drawH = sourceH * scale;
        const drawX = left + (width - drawW) / 2;
        const drawY = top + (height - drawH) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        ctx.drawImage(image, drawX, drawY, drawW, drawH);
        ctx.restore();
    }

    function normalizedPreviewItem(item, index) {
        if (!item?.filename) return null;
        const original = gjjTempImageOriginalItem(item);
        const preview = gjjTempImagePreviewItem(item);
        return {
            index: Math.max(1, Number(index) || 1),
            filename: String(item.filename || ""),
            subfolder: String(item.subfolder || ""),
            type: String(item.type || "temp"),
            original_filename: String(original?.filename || item.filename || ""),
            original_subfolder: String(original?.subfolder ?? item.subfolder ?? ""),
            original_type: String(original?.type || item.type || "temp"),
            preview_filename: String(item.preview_filename || preview?.filename || ""),
            preview_subfolder: String(item.preview_subfolder ?? preview?.subfolder ?? item.subfolder ?? ""),
            preview_type: String(item.preview_type || preview?.type || item.type || "temp"),
            preview_width: Number(item.preview_width || 0),
            preview_height: Number(item.preview_height || 0),
            cache_signature: String(item.cache_signature || ""),
            storyboard_layout_version: String(item.storyboard_layout_version || ""),
        };
    }

    function cachedPreviewItems(node) {
        try {
            const parsed = JSON.parse(String(widgetValue(node, PREVIEW_IMAGES_INPUT, "[]") || "[]"));
            return Array.isArray(parsed) ? parsed.map((item) => normalizedPreviewItem(item, item?.index)).filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    function savePreviewItem(node, cellId, item) {
        const index = Number(cellId) + 1;
        const normalized = normalizedPreviewItem(item, index);
        if (!normalized) return;
        const items = cachedPreviewItems(node).filter((entry) => Number(entry.index) !== index);
        items.push(normalized);
        items.sort((a, b) => Number(a.index) - Number(b.index));
        setWidgetValue(node, PREVIEW_IMAGES_INPUT, JSON.stringify(items));
        node.properties ||= {};
        node.properties.gjj_storyboard_video_grid_cached_preview_images_v1 = items;
        node.graph?.change?.();
    }

    function restorePreviewItems(node) {
        const propertyItems = node?.properties?.gjj_storyboard_video_grid_cached_preview_images_v1;
        const items = Array.isArray(propertyItems) && propertyItems.length ? propertyItems : cachedPreviewItems(node);
        const grid = node?.__gjjSvgPanel?.grid;
        if (!grid) return;
        for (const rawItem of items) {
            const item = normalizedPreviewItem(rawItem, rawItem?.index);
            const cellId = Math.max(0, Number(item?.index || 1) - 1);
            const cell = grid.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
            const canvas = cell?.querySelector(".gjj-svg-keyframe");
            if (!cell || !canvas || !item) continue;
            cell.__gjjCellItem = item;
            cell.dataset.previewUrl = storyboardPreviewImageUrl(item, true);
            drawCellImageToCanvas(canvas, item);
            const status = cell.querySelector(".gjj-svg-cell-status");
            if (status) status.textContent = "🖼️";
        }
    }

    function saveVideoPreviewItem(node, cellId, item, url) {
        node.properties ||= {};
        const saved = node.properties.gjj_storyboard_video_grid_cached_videos_v1;
        const items = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
        items[String(cellId)] = item?.filename || item?.url ? { ...item } : { url: String(url || "") };
        node.properties.gjj_storyboard_video_grid_cached_videos_v1 = items;
        node.graph?.change?.();
    }

    function clearVideoPreviewItems(node) {
        node.properties ||= {};
        node.properties.gjj_storyboard_video_grid_cached_videos_v1 = {};
        const grid = node?.__gjjSvgPanel?.grid;
        for (const cell of grid?.querySelectorAll?.(".gjj-svg-cell") || []) {
            delete cell.dataset.videoUrl;
            cell.__gjjVideoItem = null;
            cell.classList.remove("done", "error");
            const playBtn = cell.querySelector(".gjj-svg-cell-play");
            if (playBtn) playBtn.style.display = "none";
            const videoBtn = cell.querySelector(".gjj-svg-video-btn");
            if (videoBtn) {
                videoBtn.textContent = "🎬";
                videoBtn.title = "以当前单元格首帧为参考生成 MiniMax-H3 视频";
                videoBtn.classList.remove("ready");
                videoBtn.disabled = false;
            }
        }
        node.graph?.change?.();
        node.setDirtyCanvas?.(true, true);
    }

    function clearKeyframePreviewItems(node) {
        setWidgetValue(node, PREVIEW_IMAGES_INPUT, "[]");
        node.properties ||= {};
        node.properties.gjj_storyboard_video_grid_cached_preview_images_v1 = [];
        node.graph?.change?.();
        node.setDirtyCanvas?.(true, true);
    }

    function resetGridStateForChangedTable(node, tableSignature) {
        clearKeyframePreviewItems(node);
        clearVideoPreviewItems(node);
        setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, 0);
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, 0);
        setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
        const state = node?.__gjjSvgPanel;
        if (state) {
            state.pendingVideoIndices = [];
            state.liveVideoRunToken = "";
        }
        node.properties[TABLE_SIGNATURE_PROP] = String(tableSignature || "");
    }

    function ensureCurrentKeyframeLayoutVersion(node) {
        node.properties ||= {};
        if (String(node.properties[KEYFRAME_LAYOUT_VERSION_PROP] || "") === KEYFRAME_LAYOUT_VERSION) return;
        clearKeyframePreviewItems(node);
        clearVideoPreviewItems(node);
        node.properties[KEYFRAME_LAYOUT_VERSION_PROP] = KEYFRAME_LAYOUT_VERSION;
    }

    async function pollLiveVideoBatch(node, force = false) {
        const state = node?.__gjjSvgPanel;
        if (!state || state.liveVideoPollPending) return;
        const now = Date.now();
        if (!force && now - Number(state.lastLiveVideoPollAt || 0) < 700) return;
        state.lastLiveVideoPollAt = now;
        state.liveVideoPollPending = true;
        try {
            const path = `/gjj/storyboard-video-grid/live?node=${encodeURIComponent(String(node.id))}&_=${now}`;
            const response = await fetch(api?.apiURL ? api.apiURL(path) : path, { cache: "no-store" });
            if (!response.ok) return;
            const payload = await response.json();
            const runToken = String(payload?.run_token || "");
            if (!runToken) return;
            if (state.liveVideoRunToken !== runToken) {
                state.liveVideoRunToken = runToken;
                clearVideoPreviewItems(node);
            }
            applyVideoRecords(node, payload.records, payload.total);
        } catch (error) {
            console.warn("[GJJ StoryboardVideoGrid] 读取实时视频清单失败", error);
        } finally {
            state.liveVideoPollPending = false;
        }
    }

    function restoreVideoPreviewItems(node) {
        const items = node?.properties?.gjj_storyboard_video_grid_cached_videos_v1;
        const grid = node?.__gjjSvgPanel?.grid;
        if (!grid || !items || typeof items !== "object") return;
        for (const [cellId, item] of Object.entries(items)) {
            const cell = grid.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
            if (!cell) continue;
            const url = storyboardVideoUrl(item);
            if (!url) continue;
            cell.__gjjVideoItem = item;
            cell.dataset.videoUrl = url;
            cell.classList.add("done");
            const playBtn = cell.querySelector(".gjj-svg-cell-play");
            if (playBtn) playBtn.style.display = "grid";
            const videoBtn = cell.querySelector(".gjj-svg-video-btn");
            if (videoBtn) {
                videoBtn.textContent = "▶️";
                videoBtn.title = "播放该单元格生成的视频片段";
                videoBtn.classList.add("ready");
                videoBtn.disabled = false;
            }
        }
    }

    function drawCellImageToCanvas(canvas, item) {
        if (!canvas || !item?.filename) return;
        const target = gjjTempImagePreviewItem(item) || item;
        if (!target?.filename) return;
        const url = storyboardPreviewImageUrl({ ...item, ...target }, true);
        if (!url) return;
        if (canvas.__gjjLoadingUrl === url && canvas.__gjjLoadedOk) return;
        canvas.__gjjLoadingUrl = url;
        canvas.__gjjLoadedOk = false;
        const ctx = canvas.getContext("2d");
        // 占位底色
        const paintPlaceholder = () => {
            const w = canvas.width || canvas.clientWidth || 280;
            const h = canvas.height || canvas.clientHeight || 160;
            ctx.fillStyle = "#0a1216";
            ctx.fillRect(0, 0, w, h);
        };
        const paintImage = (imgEl) => {
            // 优先使用 clientWidth/clientHeight（CSS 布局尺寸），保证像素比一致
            const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
            const w = Math.max(1, Math.round((rect?.width || canvas.clientWidth || canvas.width || 280)));
            const h = Math.max(1, Math.round((rect?.height || canvas.clientHeight || canvas.height || 160)));
            canvas.width = w;
            canvas.height = h;
            ctx.fillStyle = "#0a1216";
            ctx.fillRect(0, 0, w, h);
            // The cell already follows the source aspect ratio, so stretch only
            // to that equivalent canvas box—no cover crop on any edge.
            ctx.drawImage(imgEl, 0, 0, w, h);
            canvas.__gjjLoadedOk = true;
        };
        const tryPaintImage = (imgEl) => {
            const naturalWidth = Number(imgEl?.naturalWidth || imgEl?.videoWidth || 0);
            const naturalHeight = Number(imgEl?.naturalHeight || imgEl?.videoHeight || 0);
            const cell = canvas.closest?.(".gjj-svg-cell");
            if (cell && naturalWidth > 0 && naturalHeight > 0) {
                cell.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;
            }
            // 如果布局未就绪，下一帧再画（避免 clientWidth=0）
            // 比例变化后等待一帧，让单元格高度按原图比例完成布局。
            if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(() => paintImage(imgEl));
            } else {
                setTimeout(() => paintImage(imgEl), 0);
            }
        };
        paintPlaceholder();
        const img = new Image();
        img.loading = "eager";
        img.fetchPriority = "high";
        img.decoding = "async";
        img.onload = () => tryPaintImage(img);
        img.onerror = () => {
            // 加载失败：尝试修复（生成缩略图）后重试
            void ensureGjjTempImagePreview(api, { ...item, ...target }).then((repaired) => {
                if (!repaired) {
                    // 兜底：使用原图
                    const originalUrl = storyboardPreviewImageUrl(item, false);
                    if (originalUrl && originalUrl !== url) {
                        canvas.__gjjLoadingUrl = originalUrl;
                        const img2 = new Image();
                        img2.onload = () => tryPaintImage(img2);
                        img2.onerror = () => {};
                        img2.src = originalUrl;
                    }
                    return;
                }
                const newItem = { ...item, ...repaired };
                const newUrl = storyboardPreviewImageUrl(newItem, true, Date.now());
                canvas.__gjjLoadingUrl = newUrl;
                const img2 = new Image();
                img2.onload = () => {
                    tryPaintImage(img2);
                    canvas.dataset.item = JSON.stringify(newItem);
                };
                img2.onerror = () => {};
                img2.src = newUrl;
            });
        };
        void loadGjjPreviewBlobUrl(url).then((blobUrl) => {
            if (blobUrl) img.src = blobUrl;
            else img.src = url;
        }).catch(() => { img.src = url; });
    }

    function preloadCellFullImage(item) {
        const url = storyboardPreviewImageUrl(item, false);
        return preloadGjjFullImage(url, "high");
    }

    function openCellFullImage(item, cellNumber = 1) {
        const originalUrl = storyboardPreviewImageUrl(item, false);
        if (!originalUrl) return;
        const thumbnailUrl = storyboardPreviewImageUrl(item, true);
        const displayNumber = Math.max(1, Number(cellNumber) || 1);
        const overlay = document.createElement("div");
        overlay.style.cssText = [
            "position:fixed", "inset:0", "z-index:100000",
            "display:flex", "align-items:center", "justify-content:center",
            "overflow:hidden", "background:rgba(0,0,0,.92)", "backdrop-filter:blur(8px)",
            "cursor:zoom-out",
        ].join(";");
        const image = document.createElement("img");
        image.alt = `分镜 ${displayNumber} 原图`;
        image.dataset.gjjStoryboardFullTarget = originalUrl;
        image.style.cssText = [
            "max-width:94vw", "max-height:94vh", "object-fit:contain",
            "border-radius:8px", "box-shadow:0 14px 48px rgba(0,0,0,.55)",
            "transform-origin:center center", "transition:transform .08s ease",
            "cursor:grab",
        ].join(";");
        image.src = thumbnailUrl || originalUrl;
        bindGjjMediaDrag(image, () => item);
        const hint = document.createElement("div");
        hint.style.cssText = [
            "position:absolute", "left:50%", "bottom:18px",
            "transform:translateX(-50%)",
            "padding:5px 10px", "border-radius:999px",
            "background:rgba(0,0,0,.55)", "color:#fff",
            "font:12px/1.3 system-ui,'Microsoft YaHei',sans-serif",
            "white-space:nowrap", "pointer-events:none",
        ].join(";");
        hint.textContent = `分镜 ${displayNumber} · 正在载入原图…`;
        let scale = 1;
        const applyScale = () => {
            image.style.transform = `scale(${scale})`;
            if (image.dataset.gjjStoryboardFullReady === "true") {
                hint.textContent = scale === 1
                    ? `分镜 ${displayNumber} · 原图 · 滚轮缩放 · 点击关闭`
                    : `分镜 ${displayNumber} · 原图缩放 ${Math.round(scale * 100)}% · 点击关闭`;
            }
        };
        image.addEventListener("load", () => {
            if (image.dataset.gjjStoryboardLoadingOriginal !== "true") return;
            if (image.getAttribute("src") !== originalUrl) return;
            delete image.dataset.gjjStoryboardLoadingOriginal;
            image.dataset.gjjStoryboardFullReady = "true";
            applyScale();
        });
        image.addEventListener("error", () => {
            if (image.dataset.gjjStoryboardLoadingOriginal !== "true") return;
            delete image.dataset.gjjStoryboardLoadingOriginal;
            hint.textContent = `分镜 ${displayNumber} · 原图载入失败`;
            if (thumbnailUrl && thumbnailUrl !== originalUrl) image.src = thumbnailUrl;
        });
        overlay.addEventListener("wheel", (event) => {
            event.preventDefault();
            event.stopPropagation();
            scale = Math.max(0.1, Math.min(10, scale * (event.deltaY > 0 ? 0.9 : 1.1)));
            applyScale();
        }, { passive: false });
        const close = () => {
            document.removeEventListener("keydown", onKeyDown, true);
            overlay.remove();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape") close();
        };
        overlay.addEventListener("click", close);
        image.addEventListener("click", close);
        document.addEventListener("keydown", onKeyDown, true);
        overlay.append(image, hint);
        document.body.appendChild(overlay);
        const revealOriginal = () => {
            if (!image.isConnected || image.dataset.gjjStoryboardFullTarget !== originalUrl) return;
            image.dataset.gjjStoryboardLoadingOriginal = "true";
            image.src = originalUrl;
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(revealOriginal);
        else setTimeout(revealOriginal, 0);
        void preloadCellFullImage(item).then((entry) => {
            if (!image.isConnected || image.dataset.gjjStoryboardFullTarget !== originalUrl) return;
            if (!entry) {
                if (image.dataset.gjjStoryboardFullReady !== "true") {
                    hint.textContent = `分镜 ${displayNumber} · 原图载入失败 · 点击关闭`;
                }
                return;
            }
            delete image.dataset.gjjStoryboardLoadingOriginal;
            image.dataset.gjjStoryboardFullReady = "true";
            if (image.getAttribute("src") !== originalUrl) image.src = originalUrl;
            applyScale();
        });
    }

    function refKey(value) {
        return String(value || "").trim().replace(/^@/, "").replace(/\\/g, "/").toLowerCase();
    }

    function itemAliasKeys(item) {
        const values = [item?.reference_name, item?.name, item?.id, item?._folder_id, ...(Array.isArray(item?.tags) ? item.tags : [])];
        return values.map(refKey).filter(Boolean);
    }

    function findLibraryItem(items, name) {
        const key = refKey(name);
        if (!key) return null;
        return (items || []).find((item) => itemAliasKeys(item).includes(key))
            || (items || []).find((item) => itemAliasKeys(item).some((alias) => alias && (alias.includes(key) || key.includes(alias))))
            || null;
    }

    function findExactLibraryItem(items, name) {
        const key = refKey(name);
        if (!key) return null;
        return (items || []).find((item) => itemAliasKeys(item).includes(key)) || null;
    }

    function splitCharacterViewSuffix(name, characterItems) {
        const text = String(name || "").trim();
        if (!text) return ["", null];
        const exact = findExactLibraryItem(characterItems, text);
        if (exact) return [refKey(text), exact];
        const textKey = refKey(text);
        const prefixMatches = [];
        for (const character of characterItems) {
            for (const aliasKey of itemAliasKeys(character)) {
                if (aliasKey && textKey.startsWith(aliasKey)) {
                    prefixMatches.push({ character, aliasKey });
                }
            }
        }
        if (prefixMatches.length) {
            prefixMatches.sort((a, b) => b.aliasKey.length - a.aliasKey.length);
            return [prefixMatches[0].aliasKey, prefixMatches[0].character];
        }
        return [textKey, null];
    }

    function characterCoverUrl(character) { return gjjCharacterThumbnailPath(character); }
    function sceneCoverUrl(scene) { return gjjSceneThumbnailPath(scene); }

    function addUniqueReferenceIcon(icons, kind, name, url, fallback) {
        const key = `${kind}:${refKey(name)}`;
        if (!name) return null;
        const existing = icons.find((item) => item.key === key);
        if (existing) return existing;
        const item = { key, kind, name, url: apiMediaUrl(url), fallback };
        icons.push(item);
        return item;
    }

    const thumbnailImageCache = new Map();
    function loadThumbnailImage(url) {
        // 【保留函数名以兼容旧调用，实际渲染由下方的 drawReferenceIconIntoEl 完成】
        if (!url || url.startsWith("blob:")) return null;
        if (thumbnailImageCache.has(url)) return thumbnailImageCache.get(url);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.loading = "eager";
        thumbnailImageCache.set(url, img);
        const isScene = url.includes("scene_library");
        const id = decodeURIComponent(String(url).split("/").pop()?.replace(/\.(png|jpg)(?:\?.*)?$/i, "") || "");
        void loadGjjLibraryThumbnailBlobUrl(api, isScene ? "scene" : "character", id).then((blobUrl) => {
            if (blobUrl) { img.src = blobUrl; }
        }).catch(() => {});
        return img;
    }

    /**
     * 把角色/场景/道具引用图标画进容器元素 el（直接在 DOM imgEl 上处理 blobUrl 异步加载，避免与缓存 Image 脱钩）
     */
    function drawReferenceIconIntoEl(el, iconData, size) {
        const fallbackText = iconData.fallback || (iconData.name || "?").charAt(0);
        const paintFallback = () => {
            el.innerHTML = "";
            const fb = document.createElement("span");
            fb.textContent = fallbackText;
            fb.style.cssText = `font:${Math.max(10, size - 8)}px/1 system-ui;color:rgba(255,255,255,.92);user-select:none;`;
            el.appendChild(fb);
        };
        if (!iconData.url) {
            paintFallback();
            return;
        }
        // 先用 fallback 占位，blobUrl 加载成功后替换
        paintFallback();
        const isScene = String(iconData.url).includes("/scene_library/");
        const kind = isScene ? "scene" : "character";
        const id = decodeURIComponent(String(iconData.url).split("/").pop()?.replace(/\.(?:png|jpg)(?:\?.*)?$/i, "") || "");
        void loadGjjLibraryThumbnailBlobUrl(api, kind, id).then((blobUrl) => {
            const src = blobUrl || iconData.url;
            if (!src) return;
            const imgEl = document.createElement("img");
            imgEl.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            imgEl.alt = iconData.name || "";
            imgEl.onload = () => {
                el.innerHTML = "";
                el.appendChild(imgEl);
            };
            imgEl.onerror = paintFallback;
            imgEl.src = src;
        }).catch(paintFallback);
    }

    function promptReferenceIcons(promptText) {
        const text = String(promptText || "");
        const icons = [];
        const scenes = globalThis.GJJ_SceneLibrary?.scenes || [];
        const characters = globalThis.GJJ_CharacterLibrary?.characters || [];
        const costumes = globalThis.GJJ_CostumeLibrary?.items || [];
        for (const match of text.matchAll(SCENE_REF_RE)) {
            const rawName = match[1] || match[3] || "";
            if (!rawName || rawName === "场景" || /[:：]/.test(rawName)) continue;
            const scene = findLibraryItem(scenes, rawName) || { id: rawName, name: rawName };
            addUniqueReferenceIcon(icons, "scene", scene.name || scene.id || rawName, sceneCoverUrl(scene), "🏞");
        }
        for (const match of text.matchAll(AT_REF_RE)) {
            const rawName = String(match[1] || "").trim();
            if (!rawName) continue;
            const [name, character] = splitCharacterViewSuffix(rawName, characters);
            if (character) {
                const explicitView = String(match[2] || "").trim();
                const selectedView = explicitView
                    ? (Array.isArray(character.views) ? character.views : []).find((view) => [view?.label, view?.id].some((value) => refKey(value) === refKey(explicitView)))
                    : null;
                const iconUrl = selectedView?.url || selectedView?.preview_url || characterCoverUrl(character);
                const icon = addUniqueReferenceIcon(icons, "character", character.name || character.id || name, iconUrl, "👤");
                if (icon && !icon.source) {
                    icon.source = {
                        pattern: match[0],
                        character,
                        view: explicitView,
                    };
                }
                continue;
            }
            const costume = findLibraryItem(costumes, rawName);
            if (costume) {
                addUniqueReferenceIcon(icons, "costume", costume.name || costume.id || rawName, "", costume.category === "product" ? "📦" : "👗");
                continue;
            }
            // Keep the reference visible while the character library is still
            // loading. A library-updated event below will replace this fallback
            // with the real portrait thumbnail.
            addUniqueReferenceIcon(icons, "character", name || rawName, "", "👤");
        }
        return icons.slice(0, 6);
    }

    function characterReferenceName(character, fallback = "") {
        return String(character?.reference_name || character?.name || character?.id || fallback || "")
            .replace(/^\s*(?:♀️|♂️|♀|♂)\s*/, "")
            .trim();
    }

    function characterViewReference(character, view) {
        const name = characterReferenceName(character, character?.id);
        const label = String(view?.label || view?.id || "").trim();
        return label ? `@${name}/${label}` : `@${name}`;
    }

    function closeCharacterViewPicker(node) {
        const picker = node?.__gjjStoryboardVideoCharacterPicker;
        if (!picker) return;
        picker.cleanup?.();
        picker.root?.remove();
        node.__gjjStoryboardVideoCharacterPicker = null;
    }

    function selectedCharacterViewValues(options) {
        return (options || [])
            .filter((option) => option?.selected)
            .map((option) => option.value)
            .filter(Boolean);
    }

    function replaceShotCharacterViews(node, shot, icon, values) {
        const replacements = (values || []).filter(Boolean);
        const target = icon?.source?.character;
        if (!shot || !target || !replacements.length) return;
        // View selection belongs exclusively to the keyframe column. Freeze
        // the other columns so @角色/视图 can never become dialogue content or
        // a different voice identity.
        const originalVideoPrompt = String(shot.video_prompt || "");
        const originalDialogueText = String(shot.dialogue_text || "");

        // A connected upstream table would overwrite this local choice on the
        // next queue. Reuse the existing link toggle: remember the source and
        // disconnect it, so the user can restore it later with the chain button.
        if (storyboardTableIsConnected(node)) toggleStoryboardTableLink(node);

        let replaced = false;
        const nextReference = replacements.join(" ");
        const currentPrompt = String(shot.keyframe_prompt || "");
        let nextPrompt = currentPrompt.replace(AT_REF_RE, (match, rawName) => {
            const [, character] = splitCharacterViewSuffix(rawName, globalThis.GJJ_CharacterLibrary?.characters || []);
            if (character !== target) return match;
            if (replaced) return "";
            replaced = true;
            return nextReference;
        });
        if (!replaced) nextPrompt = `${nextPrompt.trim()} ${nextReference}`.trim();
        shot.keyframe_prompt = nextPrompt
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\s+([,，.。;；!！?？])/g, "$1")
            .trim();
        shot.video_prompt = originalVideoPrompt;
        shot.dialogue_text = originalDialogueText;

        const state = node.__gjjSvgPanel;
        const newTable = serializeTable(state?.shots || []);
        setWidgetValue(node, TABLE_WIDGET, newTable);
        const tableWidget = node.widgets?.find((widget) => widget.name === TABLE_WIDGET);
        if (tableWidget?.element && "value" in tableWidget.element) tableWidget.element.value = newTable;
        setWidgetValue(node, FULL_TABLE_INPUT, newTable);

        // The selected view changes both the generated keyframe and the video
        // based on that keyframe. Never leave either old preview visible.
        clearKeyframePreviewItems(node);
        clearVideoPreviewItems(node);
        node.properties ||= {};
        node.properties[TABLE_SIGNATURE_PROP] = "";
        renderGrid(node);
        markChanged(node);
    }

    function openCharacterViewPicker(node, shot, icon, event) {
        closeCharacterViewPicker(node);
        const character = icon?.source?.character;
        const views = Array.isArray(character?.views) ? character.views : [];
        if (!character || !views.length) return;
        const explicitView = refKey(icon.source?.view || "");
        const options = views.map((view) => {
            const label = String(view?.label || view?.id || "视图").trim();
            return {
                label,
                value: characterViewReference(character, view),
                url: apiMediaUrl(view?.url || view?.preview_url || characterCoverUrl(character)),
                selected: Boolean(explicitView && (refKey(label) === explicitView || refKey(view?.id) === explicitView)),
            };
        });
        if (!options.some((option) => option.selected)) options[0].selected = true;

        const root = document.createElement("div");
        root.style.cssText = [
            "position:fixed", "z-index:100000", "width:270px", "max-height:360px", "overflow:auto",
            "box-sizing:border-box", "padding:6px", "border:1px solid #3b5560", "border-radius:7px",
            "background:#071014", "box-shadow:0 12px 36px rgba(0,0,0,.45)",
            "display:flex", "flex-direction:column", "gap:4px",
        ].join(";");
        root.style.left = `${Math.max(8, Math.min(event.clientX + 8, window.innerWidth - 278))}px`;
        root.style.top = `${Math.max(8, Math.min(event.clientY + 8, window.innerHeight - 368))}px`;

        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:6px;color:#b8c7cf;font:700 12px/1.3 sans-serif;padding:1px 2px 4px;";
        const title = document.createElement("div");
        title.textContent = `选择 ${characterReferenceName(character)} 的视图`;
        title.title = "普通点击为单选；按住 Ctrl 或 Alt 可多选多个参考视图。";
        title.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        const apply = document.createElement("button");
        apply.type = "button";
        apply.textContent = "确定";
        apply.style.cssText = "height:24px;border:1px solid #4f8f6f;border-radius:5px;background:#1d5d39;color:#fff;font:700 12px sans-serif;cursor:pointer;padding:0 8px;";
        apply.addEventListener("click", (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            replaceShotCharacterViews(node, shot, icon, selectedCharacterViewValues(options));
            closeCharacterViewPicker(node);
        });
        header.append(title, apply);
        root.append(header);

        const refreshRows = () => {
            for (const row of root.querySelectorAll("[data-gjj-character-view-option]")) {
                const option = options[Number(row.dataset.gjjCharacterViewOption || 0)];
                const active = Boolean(option?.selected);
                row.style.background = active ? "#1b3a32" : "#142329";
                row.style.borderColor = active ? "#65d189" : "#253941";
                const check = row.querySelector("[data-gjj-character-view-check]");
                if (check) check.textContent = active ? "✓" : "";
            }
        };

        options.forEach((option, optionIndex) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.gjjCharacterViewOption = String(optionIndex);
            button.style.cssText = "display:grid;grid-template-columns:42px 1fr 20px;align-items:center;gap:7px;width:100%;min-height:46px;border:1px solid #253941;border-radius:5px;background:#142329;color:#dce7e2;text-align:left;padding:4px;cursor:pointer;font:12px/1.25 sans-serif;";
            const preview = document.createElement("div");
            preview.style.cssText = "width:40px;height:40px;border-radius:4px;background:#0b1519;overflow:hidden;display:flex;align-items:center;justify-content:center;";
            if (option.url) {
                const image = document.createElement("img");
                image.src = option.url;
                image.alt = option.label;
                image.style.cssText = "width:100%;height:100%;object-fit:cover;";
                preview.append(image);
            } else {
                preview.textContent = "👤";
            }
            const label = document.createElement("div");
            label.textContent = option.label;
            label.style.cssText = "min-width:0;white-space:normal;word-break:break-word;";
            const check = document.createElement("div");
            check.dataset.gjjCharacterViewCheck = "1";
            check.style.cssText = "width:18px;height:18px;border:1px solid #54717a;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#d9ffe8;font:900 13px sans-serif;";
            button.append(preview, label, check);
            button.addEventListener("click", (clickEvent) => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                if (clickEvent.ctrlKey || clickEvent.altKey) {
                    option.selected = !option.selected;
                    if (!selectedCharacterViewValues(options).length) option.selected = true;
                    refreshRows();
                    return;
                }
                replaceShotCharacterViews(node, shot, icon, [option.value]);
                closeCharacterViewPicker(node);
            });
            root.append(button);
        });
        refreshRows();

        const stop = (popupEvent) => popupEvent.stopPropagation();
        for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) root.addEventListener(name, stop);
        document.body.append(root);
        const onPointerDown = (docEvent) => {
            if (!root.contains(docEvent.target)) closeCharacterViewPicker(node);
        };
        const onKeyDown = (docEvent) => {
            if (docEvent.key === "Escape") closeCharacterViewPicker(node);
        };
        const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
        document.addEventListener("keydown", onKeyDown, true);
        node.__gjjStoryboardVideoCharacterPicker = {
            root,
            cleanup: () => {
                clearTimeout(timer);
                document.removeEventListener("pointerdown", onPointerDown, true);
                document.removeEventListener("keydown", onKeyDown, true);
            },
        };
    }

    // 创建宫格单元格
    function createCell(node, shot, cellId) {
        const cell = document.createElement("div");
        cell.className = "gjj-svg-cell";
        cell.dataset.cellId = String(cellId);
        cell.dataset.index = String(shot.index);
        const configuredWidth = Math.max(1, Number(widgetValue(node, "width", 1024)) || 1024);
        const configuredHeight = Math.max(1, Number(widgetValue(node, "height", 768)) || 768);
        cell.style.aspectRatio = `${configuredWidth} / ${configuredHeight}`;

        // 预览区
        const preview = document.createElement("div");
        preview.className = "gjj-svg-cell-preview";

        // Canvas 封面图（参考 GJJ_StoryboardGridGenerator 的绘制方式）
        const canvas = document.createElement("canvas");
        canvas.className = "gjj-svg-keyframe";
        canvas.tabIndex = 0;
        canvas.dataset.cellId = String(cellId);
        canvas.dataset.index = String(shot.index);
        canvas.title = "点击查看原图 · 可拖到任意对象预览器";
        canvas.style.cssText = [
            "width:100%", "height:100%", "display:block", "position:absolute",
            "top:0", "left:0", "background:#0a1216",
            "cursor:zoom-in", "transition:opacity .2s",
            "outline:none",
        ].join(";");
        // 画占位背景（camera 图标）
        (function paintPlaceholder() {
            const ctx = canvas.getContext("2d");
            const w = 560, h = 320;
            canvas.width = w;
            canvas.height = h;
            ctx.fillStyle = "#0a1216";
            ctx.fillRect(0, 0, w, h);
            // SVG 转绘：画一个简化的 camera 图标
            ctx.save();
            ctx.strokeStyle = "#446670";
            ctx.lineWidth = 6;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            // 机身
            ctx.beginPath();
            ctx.moveTo(120, 140);
            ctx.lineTo(220, 140);
            ctx.lineTo(260, 100);
            ctx.lineTo(380, 100);
            ctx.lineTo(380, 220);
            ctx.lineTo(120, 220);
            ctx.closePath();
            ctx.stroke();
            // 镜头
            ctx.beginPath();
            ctx.arc(250, 180, 38, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        })();
        preview.appendChild(canvas);

        // 用 __gjjCellItem 保存 item，供点击 / 拖拽 / hover 复用
        cell.__gjjCellItem = null;

        // 绑定拖拽（ComfyUI 媒体拖拽协议）
        bindGjjMediaDrag(canvas, () => cell.__gjjCellItem || null);

        // 点击放大查看原图
        canvas.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const item = cell.__gjjCellItem;
            if (item?.filename) openCellFullImage(item, shot.index);
        });
        canvas.addEventListener("pointerenter", () => {
            const item = cell.__gjjCellItem;
            if (item?.filename) void preloadCellFullImage(item);
        }, { passive: true });

        const video = document.createElement("video");
        video.className = "gjj-svg-video";
        video.preload = "none";
        video.muted = true;
        video.playsInline = true;
        video.style.display = "none";
        preview.appendChild(video);

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "gjj-svg-cell-play";
        playBtn.textContent = "▶️";
        playBtn.title = "打开生成的视频片段";
        playBtn.style.display = "none";
        playBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            video.pause();
            openCellVideoPlayer(cell.dataset.videoUrl, shot.index);
        });
        preview.appendChild(playBtn);

        // 悬停播放视频
        cell.addEventListener("mouseenter", () => {
            const videoUrl = cell.dataset.videoUrl;
            if (videoUrl) {
                video.src = videoUrl;
                video.style.display = "block";
                canvas.style.opacity = "0";
                video.play().catch(() => {});
            }
        });
        cell.addEventListener("mouseleave", () => {
            video.pause();
            video.currentTime = 0;
            video.style.display = "none";
            canvas.style.opacity = "1";
        });

        // 信息行
        const info = document.createElement("div");
        info.className = "gjj-svg-cell-info";
        const indexSpan = document.createElement("span");
        indexSpan.className = "gjj-svg-cell-index";
        indexSpan.textContent = `#${shot.index}`;
        const charsPerSecond = parseFloat(widgetValue(node, "chars_per_second", "3")) || 3;
        const maxShotDuration = parseFloat(widgetValue(node, "max_shot_duration", "15")) || 15;
        const frameRate = parseFloat(widgetValue(node, "frame_rate", "24")) || 24;
        const durationSpan = document.createElement("span");
        durationSpan.className = "gjj-svg-cell-duration";
        const plannedDuration = Number(shot.duration);
        const subShotCount = Math.max(1, Math.round(Number(shot.sub_shot_count) || 1));
        const durationValue = Number.isFinite(plannedDuration) && plannedDuration > 0
            ? (subShotCount === 1 ? alignedSegmentDuration(plannedDuration, frameRate) : plannedDuration)
            : estimateDuration(shot.dialogue_text, charsPerSecond, maxShotDuration, frameRate, shot.video_prompt);
        durationSpan.textContent = `${durationValue.toFixed(1)}s${subShotCount > 1 ? ` · ${subShotCount}子镜` : ""}`;
        const statusSpan = document.createElement("span");
        statusSpan.className = "gjj-svg-cell-status";
        statusSpan.textContent = "";
        statusSpan.style.display = "none";
        info.append(indexSpan, durationSpan, statusSpan);

        // Runtime-only progress overlay. It is intentionally absent from the
        // idle layout and appears only after a generating event.
        const progressOverlay = document.createElement("div");
        progressOverlay.className = "gjj-svg-cell-progress";
        progressOverlay.style.display = "none";
        const progressLabel = document.createElement("div");
        progressLabel.className = "gjj-svg-cell-progress-label";
        const progressTrack = document.createElement("div");
        progressTrack.className = "gjj-svg-cell-progress-track";
        const progressFill = document.createElement("div");
        progressFill.className = "gjj-svg-cell-progress-fill";
        progressTrack.appendChild(progressFill);
        progressOverlay.append(progressLabel, progressTrack);

        // 角色/场景引用条（使用和 GJJ_StoryboardGridGenerator 一致的逻辑）
        const refBar = document.createElement("div");
        refBar.className = "gjj-svg-cell-refs";
        refBar.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;padding:2px 5px;align-items:center;min-height:20px;";
        const allText = [shot.keyframe_prompt, shot.video_prompt, shot.dialogue_text].filter(Boolean).join(" ");
        const icons = promptReferenceIcons(allText);
        for (const iconData of icons) {
            const size = 20;
            const el = document.createElement("div");
            const selectableCharacter = iconData.kind === "character" && Array.isArray(iconData.source?.character?.views) && iconData.source.character.views.length > 0;
            el.style.cssText = `width:${size}px;height:${size}px;border-radius:5px;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;border:1px solid ${iconData.kind === "scene" ? "rgba(56,189,248,.7)" : iconData.kind === "character" ? "rgba(250,204,21,.7)" : "rgba(167,139,250,.7)"};background:rgba(0,0,0,.5);cursor:${selectableCharacter ? "pointer" : "default"};position:relative;flex-shrink:0;`;
            el.title = selectableCharacter
                ? `${iconData.name}${iconData.source?.view ? ` · 当前：${iconData.source.view}` : ""} · 点击选择角色视图`
                : iconData.name;
            // 直接在 el 上异步加载 blobUrl，避免缓存 Image 对象与显示 imgEl 脱钩
            drawReferenceIconIntoEl(el, iconData, size);
            if (selectableCharacter) {
                el.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openCharacterViewPicker(node, shot, iconData, event);
                });
            }
            refBar.appendChild(el);
        }
        if (!icons.length) {
            refBar.style.display = "none";
        }

        // 提示词区域（可双击编辑）
        const promptArea = document.createElement("div");
        promptArea.className = "gjj-svg-cell-prompt";
        const promptText = document.createElement("div");
        promptText.className = "gjj-svg-cell-prompt-text";
        const promptContent = shot.keyframe_prompt || shot.video_prompt || shot.dialogue_text || "（未填写，双击编辑）";
        promptText.textContent = `✏️ ${shot.index}||${promptContent.slice(0, 60)}`;
        promptText.title = `双击编辑分镜 ${shot.index}\n\n关键帧：${shot.keyframe_prompt || "—"}\n视频：${shot.video_prompt || "—"}\n台词：${shot.dialogue_text || "—"}`;
        promptArea.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
            editCellPrompt(node, cell, shot.index);
        });
        promptArea.appendChild(promptText);

        // 操作按钮
        const toolbar = document.createElement("div");
        toolbar.className = "gjj-svg-cell-toolbar";

        const keyframeBtn = document.createElement("button");
        keyframeBtn.type = "button";
        keyframeBtn.className = "gjj-svg-cell-btn gjj-svg-keyframe-btn";
        keyframeBtn.textContent = "🖼️";
        keyframeBtn.title = "生成首帧图片";
        keyframeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            generateCellKeyframe(node, shot.index);
        });

        const videoBtn = document.createElement("button");
        videoBtn.type = "button";
        videoBtn.className = "gjj-svg-cell-btn gjj-svg-video-btn";
        videoBtn.textContent = "🎬";
        videoBtn.title = "以当前单元格首帧为参考生成 MiniMax-H3 视频";
        videoBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (cell.dataset.videoUrl) {
                openCellVideoPlayer(cell.dataset.videoUrl, shot.index);
                return;
            }
            generateCellVideo(node, shot.index);
        });

        toolbar.append(keyframeBtn, videoBtn);

        // 选中（单击）vs 编辑（双击）：用 setTimeout 去抖避免双击触发两次单击
        let clickTimer = null;
        cell.addEventListener("click", (event) => {
            // 点击预览图区域时让 Canvas 自己的点击处理（放大预览）
            const target = event.target;
            if (target && (target === canvas || canvas.contains(target))) return;
            event.stopPropagation();
            if (event.button !== 0) return;
            if (clickTimer) return; // 双击 pending，不处理单击
            clickTimer = setTimeout(() => {
                clickTimer = null;
                selectCell(node, cell, event.ctrlKey || event.metaKey, event.shiftKey);
            }, 220);
        });
        cell.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            editCellPrompt(node, cell, shot.index);
        });

        cell.append(preview, progressOverlay, info, refBar, promptArea, toolbar);
        return cell;
    }

    // 双击编辑宫格提示词
    function editCellPrompt(node, cell, index) {
        const state = node.__gjjSvgPanel;
        if (!state) return;
        const shots = state.shots;
        const shot = shots.find(s => s.index === index);
        if (!shot) return;
        const displayIndex = shot.index;

        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);";
        const box = document.createElement("div");
        box.style.cssText = "width:min(560px,92vw);max-height:80vh;background:#0c1215;border:1px solid #3a4f55;border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);display:flex;flex-direction:column;";
        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2a3a40;";
        const title = document.createElement("span");
        title.textContent = `✏️ 编辑分镜 ${displayIndex}`;
        title.style.cssText = "font:700 13px/1 system-ui; color:#cfe8e8;";
        const close = document.createElement("button");
        close.textContent = "✕";
        close.style.cssText = "margin-left:auto;padding:4px 10px;border:1px solid #3a4a50;border-radius:5px;background:#1a2a30;color:#cfe8e8;cursor:pointer;";
        header.append(title, close);
        box.appendChild(header);

        const body = document.createElement("div");
        body.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;";
        const rows = [
            { label: "关键帧提示词", key: "keyframe_prompt" },
            { label: "视频提示词", key: "video_prompt" },
            { label: "台词（@角色：台词，多个用逗号分隔）", key: "dialogue_text" },
        ];
        const areas = {};
        for (const r of rows) {
            const lab = document.createElement("label");
            lab.textContent = r.label;
            lab.style.cssText = "font:11px/1.2 system-ui; color:#aac0c8; display:block; margin-bottom:2px;";
            const ta = document.createElement("textarea");
            ta.value = shot[r.key] || "";
            ta.rows = r.key === "dialogue_text" ? 3 : 3;
            ta.style.cssText = "width:100%;min-height:50px;padding:6px 8px;border:1px solid #334850;border-radius:5px;background:#0a1216;color:#eef5f5;font:12px/1.4 system-ui;font-family:ui-monospace,Consolas,monospace;box-sizing:border-box;outline:none;resize:vertical;";
            ta.addEventListener("focus", () => { ta.style.borderColor = "#6a9dae"; });
            ta.addEventListener("blur", () => { ta.style.borderColor = "#334850"; });
            body.append(lab, ta);
            areas[r.key] = ta;
        }
        box.appendChild(body);

        const footer = document.createElement("div");
        footer.style.cssText = "display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;border-top:1px solid #2a3a40;";
        const cancel = document.createElement("button");
        cancel.textContent = "取消";
        const save = document.createElement("button");
        save.textContent = "保存";
        save.style.cssText = "background:#1a4a3a;border-color:#3f7a65;color:#9be0b5;";
        for (const b of [cancel, save]) {
            b.style.padding = "6px 16px";
            b.style.border = "1px solid #3a4a50";
            b.style.borderRadius = "5px";
            if (b !== save) b.style.background = "#1a2a30";
            b.style.color = b.style.color || "#cfe8e8";
            b.style.cursor = "pointer";
            b.style.font = "12px/1 system-ui";
            b.addEventListener("mouseenter", () => { if (b !== save) b.style.background = "#264558"; else b.style.background = "#2a5a4a"; });
            b.addEventListener("mouseleave", () => { if (b !== save) b.style.background = "#1a2a30"; else b.style.background = "#1a4a3a"; });
        }
        footer.append(cancel, save);
        box.appendChild(footer);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const closeModal = () => { if (overlay.isConnected) overlay.remove(); };
        close.addEventListener("click", closeModal);
        cancel.addEventListener("click", closeModal);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) closeModal();
            e.stopPropagation();
        });
        save.addEventListener("click", () => {
            shot.keyframe_prompt = String(areas.keyframe_prompt.value || "").trim();
            shot.video_prompt = String(areas.video_prompt.value || "").trim();
            shot.dialogue_text = String(areas.dialogue_text.value || "").trim();
            const newTable = serializeTable(shots);
            setWidgetValue(node, TABLE_WIDGET, newTable);
            // 同步原生 textarea
            const w = node.widgets?.find((x) => x.name === TABLE_WIDGET);
            if (w?.element && "value" in w.element) {
                w.element.value = newTable;
            }
            renderGrid(node);
            markChanged(node);
            closeModal();
        });
        setTimeout(() => areas.keyframe_prompt.focus(), 0);
    }

    let lastSelectedCellId = -1;

    function selectCell(node, cell, ctrl, shift) {
        const grid = cell.parentElement;
        if (!grid) return;
        const cells = Array.from(grid.querySelectorAll(".gjj-svg-cell"));
        const currentCellId = parseInt(cell.dataset.cellId, 10);

        if (shift && lastSelectedCellId >= 0) {
            const start = Math.min(lastSelectedCellId, currentCellId);
            const end = Math.max(lastSelectedCellId, currentCellId);
            cells.forEach((c) => {
                const cid = parseInt(c.dataset.cellId, 10);
                if (cid >= start && cid <= end) c.classList.add("selected");
            });
        } else if (ctrl) {
            cell.classList.toggle("selected");
        } else {
            cells.forEach((c) => c.classList.remove("selected"));
            cell.classList.add("selected");
        }
        lastSelectedCellId = currentCellId;
        updateSelectedIndices(node);
    }

    function updateSelectedIndices(node) {
        const state = node.__gjjSvgPanel;
        if (!state?.grid) return;
        const selected = Array.from(state.grid.querySelectorAll(".gjj-svg-cell.selected"))
            .map((c) => parseInt(c.dataset.index, 10))
            .filter((n) => !isNaN(n));
        setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, JSON.stringify(selected));
    }

    function getSelectedIndices(node) {
        const state = node.__gjjSvgPanel;
        if (!state?.grid) return [];
        return Array.from(state.grid.querySelectorAll(".gjj-svg-cell.selected"))
            .map((c) => parseInt(c.dataset.index, 10))
            .filter((n) => !isNaN(n));
    }

    // 生成单格首帧
    async function generateCellKeyframe(node, index) {
        const state = node.__gjjSvgPanel;
        if (!state || state.generating) return;
        state.generating = true;
        showNodeProgress(node, `准备生成图片 · 分镜 ${index}`, 0);

        setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, index);
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, state.totalCells);
        setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
        setWidgetValue(node, FULL_TABLE_INPUT, storyboardTableSnapshot(node));
        setWidgetValue(node, FORCE_GENERATE_INPUT, "keyframe_only");

        // 用 shot.index 找到 shot 对应的 cellId
        const shot = state.shots.find(s => s.index === index);
        const cellId = shot ? shot.cellId : (index - 1);
        const cellEl = state.grid?.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
        if (cellEl) {
            const status = cellEl.querySelector(".gjj-svg-cell-status");
            if (status) status.textContent = "🎨";
            cellEl.classList.add("generating");
        }

        try {
            await queueOnlyCurrentNode(node);
        } catch (err) {
            console.error("[GJJ StoryboardVideoGrid] 生成首帧失败：", err);
        } finally {
            setTimeout(() => {
                state.generating = false;
                if (cellEl) cellEl.classList.remove("generating");
            }, 500);
        }
    }

    // 生成单格视频
    async function generateCellVideo(node, index) {
        const state = node.__gjjSvgPanel;
        if (!state || state.generating) return;
        state.generating = true;
        showNodeProgress(node, `准备生成视频 · 分镜 ${index}`, 0);

        setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, index);
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, state.totalCells);
        setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
        setWidgetValue(node, FULL_TABLE_INPUT, storyboardTableSnapshot(node));
        setWidgetValue(node, FORCE_GENERATE_INPUT, "video_only");

        // 用 shot.index 找到 shot 对应的 cellId
        const shot = state.shots.find(s => s.index === index);
        const cellId = shot ? shot.cellId : (index - 1);
        const cellEl = state.grid?.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
        if (cellEl) {
            const status = cellEl.querySelector(".gjj-svg-cell-status");
            if (status) status.textContent = "🎬";
            cellEl.classList.add("generating");
        }

        try {
            await queueOnlyCurrentNode(node);
        } catch (err) {
            console.error("[GJJ StoryboardVideoGrid] 生成视频失败：", err);
        } finally {
            setTimeout(() => {
                state.generating = false;
                if (cellEl) cellEl.classList.remove("generating");
            }, 500);
        }
    }

    // 重新生成指定格子（完整：首帧+视频）
    async function regenerateCells(node, indices) {
        if (!indices || !indices.length) return;
        const state = node.__gjjSvgPanel;
        if (!state || state.generating) return;
        state.generating = true;
        showNodeProgress(node, `准备重新生成 ${indices.length} 个分镜`, 0);

        if (indices.length === 1) {
            setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, indices[0]);
            setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, state.totalCells);
            setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
        } else {
            setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, 0);
            setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, state.totalCells);
            setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, JSON.stringify(indices));
        }
        setWidgetValue(node, FULL_TABLE_INPUT, storyboardTableSnapshot(node));
        setWidgetValue(node, FORCE_GENERATE_INPUT, "true");

        // 用 cellId 查找 cell（避免 index 重复冲突）
        for (const idx of indices) {
            const shot = state.shots.find(s => s.index === idx);
            const cellId = shot ? shot.cellId : (idx - 1);
            const cellEl = state.grid?.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
            if (cellEl) {
                const status = cellEl.querySelector(".gjj-svg-cell-status");
                if (status) status.textContent = "⏳";
                cellEl.classList.add("generating");
            }
        }

        try {
            await queueOnlyCurrentNode(node);
        } catch (err) {
            console.error("[GJJ StoryboardVideoGrid] 重新生成失败：", err);
        } finally {
            setTimeout(() => {
                state.generating = false;
                for (const idx of indices) {
                    const shot = state.shots.find(s => s.index === idx);
                    const cellId = shot ? shot.cellId : (idx - 1);
                    const cellEl = state.grid?.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
                    if (cellEl) cellEl.classList.remove("generating");
                }
            }, 500);
        }
    }

    // 全量生成
    async function generateAll(node, mode = "keyframe_only") {
        const state = node.__gjjSvgPanel;
        if (!state || state.generating) return;
        state.generating = true;
        showNodeProgress(node, mode === "video_only" ? "准备生成全部视频" : "准备生成全部图片", 0);
        setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, 0);
        if (mode === "video_only" || mode === "all") {
            state.liveVideoRunToken = "";
            clearVideoPreviewItems(node);
        }
        if (mode === "video_only") {
            const allIndices = (state.shots || []).map((shot) => Number(shot.index)).filter(Number.isFinite);
            state.pendingVideoIndices = allIndices.slice();
            setWidgetValue(node, FULL_TABLE_INPUT, storyboardTableSnapshot(node));
            setWidgetValue(node, FORCE_GENERATE_INPUT, "video_only");
            // A full-batch request must leave single/selected-cell mode
            // completely disabled.  Keeping totalCells here made a stale
            // selected_cell_indices value (for example [8]) authoritative,
            // so the backend generated only that one cell.
            setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, 0);
            setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
            console.log("[GJJ StoryboardVideoGrid] 一次提交全部分镜视频，由后端顺序轻量生成", allIndices);
            for (const cell of state.grid?.querySelectorAll(".gjj-svg-cell") || []) {
                const button = cell.querySelector(".gjj-svg-video-btn");
                if (!button || cell.dataset.videoUrl) continue;
                button.textContent = "⏳";
                button.title = "等待批量生成该分镜视频";
                button.disabled = true;
            }
            try {
                await queueOnlyCurrentNode(node);
            } catch (err) {
                console.error("[GJJ StoryboardVideoGrid] 批量视频生成失败：", err);
            } finally {
                setWidgetValue(node, SINGLE_CELL_INDEX_INPUT, 0);
                setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, 0);
                setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
                setTimeout(() => { state.generating = false; }, 500);
            }
            return;
        } else {
            setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, 0);
            setWidgetValue(node, SELECTED_CELL_INDICES_INPUT, "[]");
            setWidgetValue(node, FULL_TABLE_INPUT, "");
        }
        setWidgetValue(node, FORCE_GENERATE_INPUT, mode);
        try {
            await queueOnlyCurrentNode(node);
        } catch (err) {
            console.error("[GJJ StoryboardVideoGrid] 全量生成失败：", err);
        } finally {
            setTimeout(() => { state.generating = false; }, 500);
        }
    }

    // 渲染宫格
    function renderGrid(node) {
        closeCharacterViewPicker(node);
        const state = node.__gjjSvgPanel;
        if (!state?.grid) return;
        const tableText = widgetValue(node, TABLE_WIDGET);
        const shots = parseTable(tableText);
        // 外接表格的最新文本只存在于本次后端队列中，本地 widget 可能为空。
        // 实时事件已创建宫格时，不允许普通重绘重新把它清成空状态。
        if (!shots.length && storyboardTableIsConnected(node) && Number(state.liveTotalCells) > 0) {
            return;
        }
        state.shots = shots;
        state.totalCells = shots.length;
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, shots.length);

        state.grid.replaceChildren();
        if (!shots.length) {
            state.grid.style.display = "none";
            scheduleCompactEmptyNode(node);
            return;
        }
        state.grid.style.display = "grid";
        for (const shot of shots) {
            const cell = createCell(node, shot, shot.cellId);
            state.grid.appendChild(cell);
        }
        restorePreviewItems(node);
        restoreVideoPreviewItems(node);
        scheduleExpandNodeForPreview(node);
    }

    function ensureLiveGrid(node, detail = {}) {
        const state = node?.__gjjSvgPanel;
        if (!state?.grid) return;
        const total = Math.max(1, Math.round(Number(detail.total) || Number(detail.index) || 1));
        const existingCells = state.grid.querySelectorAll(".gjj-svg-cell").length;
        if (existingCells >= total) {
            state.liveTotalCells = Math.max(Number(state.liveTotalCells) || 0, total);
            const liveIndex = Math.max(1, Math.round(Number(detail.index) || 1));
            const livePrompt = String(detail.prompt || "").trim();
            const shot = state.shots?.[liveIndex - 1];
            if (shot && livePrompt) shot.keyframe_prompt = livePrompt;
            const promptLabel = state.grid.querySelector(
                `.gjj-svg-cell[data-cell-id="${liveIndex - 1}"] .gjj-svg-cell-prompt-text`,
            );
            if (promptLabel && livePrompt) {
                promptLabel.textContent = `✏️ ${liveIndex}||${livePrompt.slice(0, 60)}`;
                promptLabel.title = livePrompt;
            }
            return;
        }

        const previousShots = Array.isArray(state.shots) ? state.shots : [];
        const promptIndex = Math.max(1, Math.round(Number(detail.index) || 1));
        const promptText = String(detail.prompt || "").trim();
        const liveShots = Array.from({ length: total }, (_value, cellId) => {
            const index = cellId + 1;
            const previous = previousShots[cellId];
            if (previous) return { ...previous, cellId };
            return {
                index,
                cellId,
                keyframe_prompt: index === promptIndex ? promptText : `分镜 ${index}`,
                video_prompt: "",
                dialogue_text: "",
            };
        });
        state.shots = liveShots;
        state.totalCells = total;
        state.liveTotalCells = total;
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, total);
        state.grid.replaceChildren();
        state.grid.style.display = "grid";
        for (const shot of liveShots) state.grid.appendChild(createCell(node, shot, shot.cellId));
        restorePreviewItems(node);
        restoreVideoPreviewItems(node);
        scheduleExpandNodeForPreview(node);
        node.setDirtyCanvas?.(true, true);
    }

    function applyStoryboardPlan(node, detail = {}) {
        const state = node?.__gjjSvgPanel;
        const cells = Array.isArray(detail.cells) ? detail.cells : [];
        if (!state?.grid || !cells.length) return;
        const shots = cells.map((cell, cellId) => ({
            index: Math.max(1, Math.round(Number(cell?.index) || cellId + 1)),
            cellId,
            keyframe_prompt: String(cell?.keyframe_prompt || ""),
            video_prompt: String(cell?.video_prompt || ""),
            dialogue_text: String(cell?.dialogue_text || ""),
            duration: Math.max(0, Number(cell?.duration) || 0),
            sub_shot_count: Math.max(1, Math.round(Number(cell?.sub_shot_count) || 1)),
        }));
        state.shots = shots;
        state.totalCells = shots.length;
        state.liveTotalCells = shots.length;
        setWidgetValue(node, SINGLE_CELL_TOTAL_INPUT, shots.length);
        state.grid.replaceChildren();
        state.grid.style.display = "grid";
        for (const shot of shots) state.grid.appendChild(createCell(node, shot, shot.cellId));
        restorePreviewItems(node);
        restoreVideoPreviewItems(node);
        scheduleExpandNodeForPreview(node);
        node.setDirtyCanvas?.(true, true);
    }

    // 更新单格预览
    function updateCell(node, data) {
        const state = node.__gjjSvgPanel;
        if (!state?.grid) {
            console.warn("[GJJ StoryboardVideoGrid] updateCell: grid 未初始化", { nodeId: node.id, data });
            return;
        }
        if (String(data.node) !== String(node.id)) return;
        // 优先用 cell_id（顺序编号）查找，避免 index 重复冲突
        const cellId = data.cell_id != null ? data.cell_id : (data.index - 1);
        const cell = state.grid.querySelector(`.gjj-svg-cell[data-cell-id="${cellId}"]`);
        if (!cell) {
            console.warn("[GJJ StoryboardVideoGrid] updateCell: 找不到 cell", { cellId, index: data.index, totalCells: state.totalCells });
            return;
        }
        const status = cell.querySelector(".gjj-svg-cell-status");
        const canvas = cell.querySelector(".gjj-svg-keyframe");
        const progressOverlay = cell.querySelector(".gjj-svg-cell-progress");
        const progressLabel = cell.querySelector(".gjj-svg-cell-progress-label");
        const progressFill = cell.querySelector(".gjj-svg-cell-progress-fill");
        const showProgress = (label, progress = null) => {
            cell.classList.add("generating");
            showNodeProgress(node, label, progress);
            if (progressOverlay) progressOverlay.style.display = "flex";
            if (progressLabel) progressLabel.textContent = label;
            if (progressFill) {
                const numeric = Number(progress);
                progressFill.style.width = Number.isFinite(numeric) && numeric > 0
                    ? `${Math.max(2, Math.min(100, numeric * 100))}%`
                    : "32%";
                progressFill.classList.toggle("indeterminate", !(Number.isFinite(numeric) && numeric > 0));
            }
        };
        const hideProgress = () => {
            cell.classList.remove("generating");
            if (progressOverlay) progressOverlay.style.display = "none";
            if (progressFill) progressFill.classList.remove("indeterminate");
            if (!state.grid.querySelector(".gjj-svg-cell.generating")) hideNodeProgress(node);
        };

        if (data.phase === "keyframe") {
            if (data.status === "done" && (data.preview_url || data.item)) {
                // 优先使用后端传来的 item（包含 filename/subfolder/type 等元信息）
                const rawItem = data.item && typeof data.item === "object" ? data.item : {};
                const hasFilename = rawItem && rawItem.filename;
                const item = hasFilename
                    ? { ...rawItem }
                    : { filename: String(data.preview_url || ""), subfolder: "", type: "temp" };
                cell.__gjjCellItem = item;
                cell.dataset.previewUrl = storyboardPreviewImageUrl(item, true) || String(data.preview_url || "");
                savePreviewItem(node, cellId, item);
                console.log("[GJJ StoryboardVideoGrid] 设置预览图", { index: data.index, item });
                if (canvas) drawCellImageToCanvas(canvas, item);
                hideProgress();
            } else if (data.status === "generating") {
                showProgress("🎨 图片生成中…", data.progress);
            } else if (data.status === "error") {
                hideProgress();
                cell.classList.add("error");
            }
        } else if (data.phase === "video") {
            const videoBtn = cell.querySelector(".gjj-svg-video-btn");
            if (data.status === "done" && (data.video_url || data.item)) {
                const finalVUrl = storyboardVideoUrl(
                    data.item && typeof data.item === "object" ? data.item : null,
                    data.video_url,
                );
                cell.dataset.videoUrl = finalVUrl;
                cell.__gjjVideoItem = data.item && typeof data.item === "object" ? { ...data.item } : null;
                saveVideoPreviewItem(node, cellId, cell.__gjjVideoItem, finalVUrl);
                const playBtn = cell.querySelector(".gjj-svg-cell-play");
                if (playBtn) playBtn.style.display = finalVUrl ? "grid" : "none";
                if (videoBtn && finalVUrl) {
                    videoBtn.textContent = "▶️";
                    videoBtn.title = "播放该单元格生成的视频片段";
                    videoBtn.classList.add("ready");
                    videoBtn.disabled = false;
                }
                hideProgress();
                cell.classList.add("done");
                if (data.duration) {
                    const dur = cell.querySelector(".gjj-svg-cell-duration");
                    if (dur) dur.textContent = `${parseFloat(data.duration).toFixed(1)}s`;
                }
            } else if (data.status === "generating") {
                if (videoBtn) {
                    videoBtn.textContent = "⏳";
                    videoBtn.title = "该单元格视频正在生成";
                    videoBtn.disabled = true;
                }
                showProgress("🎬 视频生成中…", data.progress);
            } else if (data.status === "error") {
                if (videoBtn) {
                    videoBtn.textContent = "🎬";
                    videoBtn.title = "视频生成失败，点击重试";
                    videoBtn.disabled = false;
                    videoBtn.classList.remove("ready");
                }
                hideProgress();
                cell.classList.add("error");
            }
        }
    }

    function normalizedVideoRecords(value) {
        const records = [];
        const visit = (candidate) => {
            if (Array.isArray(candidate)) {
                for (const item of candidate) visit(item);
            } else if (candidate && typeof candidate === "object" && (candidate.cell_id != null || candidate.index != null)) {
                records.push(candidate);
            }
        };
        visit(value);
        return records;
    }

    function normalizedVideoItems(value) {
        const items = [];
        const visit = (candidate) => {
            if (Array.isArray(candidate)) {
                for (const item of candidate) visit(item);
            } else if (candidate && typeof candidate === "object" && (candidate.filename || candidate.url)) {
                items.push(candidate);
            } else if (typeof candidate === "string" && candidate.trim()) {
                items.push({ url: candidate.trim() });
            }
        };
        visit(value);
        return items;
    }

    function applyStandardVideoItems(node, value) {
        const items = normalizedVideoItems(value);
        if (!items.length) return 0;
        const state = node.__gjjSvgPanel;
        const indices = Array.isArray(state?.pendingVideoIndices) && state.pendingVideoIndices.length
            ? state.pendingVideoIndices
            : (state?.shots || []).map((shot) => Number(shot.index));
        const records = items.slice(0, indices.length).map((item, offset) => {
            const index = indices[offset];
            const shot = state?.shots?.find?.((candidate) => Number(candidate.index) === Number(index));
            return {
                cell_id: shot?.cellId ?? offset,
                index,
                duration: shot ? estimateDuration(
                    shot.dialogue_text,
                    parseFloat(widgetValue(node, "chars_per_second", "3")) || 3,
                    parseFloat(widgetValue(node, "max_shot_duration", "15")) || 15,
                    parseFloat(widgetValue(node, "frame_rate", "24")) || 24,
                    shot.video_prompt,
                ) : 0,
                item,
                video_url: item?.url || "",
            };
        });
        return applyVideoRecords(node, records, indices.length);
    }

    function applyVideoRecords(node, recordsValue, totalValue = 0) {
        const records = normalizedVideoRecords(recordsValue);
        for (const record of records) {
            updateCell(node, {
                node: String(node.id),
                cell_id: record?.cell_id,
                index: record?.index,
                phase: "video",
                status: "done",
                duration: record?.duration,
                item: record?.item || {},
                video_url: record?.video_url || "",
            });
        }
        const total = Math.max(records.length, Number(totalValue) || 0);
        if (records.length && records.length >= total) {
            showNodeProgress(node, `全部分镜视频生成完成 · ${records.length}/${total}`, 1);
            hideNodeProgress(node, 1400);
        }
        return records.length;
    }

    // ====== 浮动窗口管理 ======
    function closeAllFloats(node) {
        const state = node.__gjjSvgPanel;
        if (state?.floatHost) {
            state.floatHost.querySelectorAll(".gjj-svg-float").forEach((f) => f.remove());
        }
        // 同时清理全局 floats
        document.querySelectorAll(`.gjj-svg-float[data-node="${node.id}"]`).forEach((f) => f.remove());
        if (state?.toolbar) {
            state.toolbar.querySelectorAll("button.gjj-svg-btn.active").forEach((b) => {
                if (b.dataset.floatBtn) b.classList.remove("active");
            });
        }
    }

    function toggleFloat(node, floatClass, builder, btn) {
        const state = node.__gjjSvgPanel;
        if (!state) return;
        // 查找已存在的浮动
        const existing = document.querySelector(`.gjj-svg-float.${floatClass}[data-node="${node.id}"]`);
        if (existing) {
            closeAllFloats(node);
            return;
        }
        closeAllFloats(node);
        const float = builder();
        if (float) {
            float.dataset.node = String(node.id);
            float.dataset.floatClass = floatClass;
            // 浮动窗口添加到 document.body，用绝对定位 + 相对按钮
            document.body.appendChild(float);
            positionFloatNearButton(node, btn, float);
            window.addEventListener("scroll", () => {
                if (float.isConnected) positionFloatNearButton(node, btn, float);
            }, { once: true });
            if (btn) {
                btn.dataset.floatBtn = "1";
                btn.classList.add("active");
            }
        }
    }

    function positionFloatNearButton(node, btn, float) {
        if (!btn || !float) return;
        const btnRect = btn.getBoundingClientRect();
        const canvasEl = document.querySelector(".litegraph.litecanvas") || document.querySelector("#graph-canvas");
        const canvasRect = canvasEl?.getBoundingClientRect?.() || { left: 0, top: 0 };
        float.style.position = "fixed";
        float.style.top = `${Math.min(window.innerHeight - 120, btnRect.bottom + 6)}px`;
        float.style.right = `${Math.max(10, window.innerWidth - btnRect.right)}px`;
        float.style.maxWidth = `min(460px, ${window.innerWidth - 40}px)`;
        float.style.maxHeight = `${Math.max(280, window.innerHeight - btnRect.bottom - 60)}px`;
        float.style.zIndex = "99999";
    }

    function createFloatShell(titleText, floatClass) {
        const float = document.createElement("div");
        float.className = `gjj-svg-float ${floatClass}`;
        float.style.cssText = `position:fixed;min-width:440px;width:min(440px,92%);max-height:520px;overflow:auto;padding:10px;border:1px solid #526a73;border-radius:10px;background:rgba(13,22,25,.985);box-shadow:0 14px 40px rgba(0,0,0,.7);z-index:99999;`;
        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid rgba(82,106,115,.5);margin-bottom:8px;";
        const title = document.createElement("span");
        title.textContent = titleText;
        title.style.cssText = "font:700 13px/1 system-ui; color:#cfe8e8;";
        const close = document.createElement("button");
        close.textContent = "✕";
        close.style.cssText = "margin-left:auto;padding:3px 10px;border:1px solid #3a4a50;border-radius:5px;background:#1a2a30;color:#cfe8e8;cursor:pointer;";
        close.addEventListener("click", () => {
            const nodeId = float.dataset.node;
            const node = (app.graph?._nodes || []).find((n) => String(n.id) === String(nodeId));
            if (node) closeAllFloats(node);
            else float.remove();
        });
        header.append(title, close);
        float.appendChild(header);
        return float;
    }

    // ====== 模型配置浮动窗口 ======
    function buildModelFloat(node) {
        const float = createFloatShell("🧠 模型配置", "gjj-svg-model-float");
        const modelWidgets = [
            { name: "keyframe_unet", label: "起始帧模型", folder: "diffusion_models", icon: "🟣" },
            { name: "keyframe_clip", label: "起始帧CLIP", folder: "text_encoders", icon: "🟡" },
            { name: "keyframe_vae", label: "起始帧VAE", folder: "vae", icon: "🔴" },
            { name: "video_clip", label: "视频CLIP", folder: "text_encoders", icon: "🟡" },
            { name: "video_vae", label: "视频VAE", folder: "vae", icon: "🔴" },
            { name: "video_audio_vae", label: "音频VAE", folder: "vae", icon: "🔴" },
            { name: "video_ref_unet", label: "参考视频模型", folder: "diffusion_models", icon: "🟣" },
        ];
        const entries = modelWidgets.map((mw) => {
            const widget = node.widgets?.find((w) => w.name === mw.name);
            const options = widget?.options?.values || [];
            let value = widget ? widget.value : "";
            // 如果当前 value 不在可用列表中，用 Python 端的 default 替换
            if (options.length && (!value || !options.some(o => String(o) === String(value)))) {
                const pyDefault = widget?.options?.default || "";
                value = String(pyDefault || options[0] || "");
                if (widget) widget.value = value;
            }
            return {
                folder: mw.folder,
                filename: value,
                label: mw.label,
                icon: mw.icon,
                models: options.length ? options : [value],
                defaultModel: value,
                autoSelect: true,
                getWidget: () => widget,
            };
        });
        try {
            const treeView = GJJ_Utils.createModelTreeView({
                node,
                entries,
                onApply: (entry, value, widget) => {
                    if (widget) {
                        widget.value = value;
                        if (typeof widget.callback === "function") widget.callback(value);
                    }
                    markChanged(node);
                },
            });
            float.appendChild(treeView);
            const loraTreeHost = document.createElement("div");
            loraTreeHost.style.marginTop = "8px";
            loraTreeHost.textContent = "正在读取 LoRA 目录树…";
            loraTreeHost.style.color = "#8faeb4";
            float.appendChild(loraTreeHost);
            fetch("/gjj/loras").then((response) => response.ok ? response.json() : null).then((data) => {
                const loraModels = (Array.isArray(data) ? data : (data?.loras || []))
                    .filter((name) => name && !String(name).startsWith("."))
                    .map(String).sort();
                const makeJsonLoraAdapter = (widgetName, matches, fallback) => {
                    const source = node.widgets?.find((item) => item.name === widgetName);
                    return {
                        get value() {
                            const row = _parseLoraData(source?.value).find((item) => matches(String(item?.name || "")));
                            return String(row?.name || fallback || "");
                        },
                        set value(next) {
                            if (!source) return;
                            const rows = _parseLoraData(source.value).filter((item) => !matches(String(item?.name || "")));
                            if (String(next || "").trim()) rows.push({ enabled: true, name: String(next), strength: 1.0 });
                            source.value = JSON.stringify(rows);
                        },
                        options: { values: loraModels },
                        callback(next) { this.value = next; },
                    };
                };
                const nextSceneAdapter = makeJsonLoraAdapter(
                    "keyframe_lora_data",
                    (name) => name.toLowerCase().includes("next-scene"),
                    loraModels.find((name) => name.toLowerCase().includes("next-scene_lora-v2-3000")) || "",
                );
                const imageAccelAdapter = makeJsonLoraAdapter(
                    "keyframe_lora_data",
                    (name) => name.toLowerCase().includes("lightning"),
                    loraModels.find((name) => name.replaceAll("\\", "/").split("/").pop().toLowerCase() === "qwen-image-edit-2511-lightning-4steps-v1.0-bf16.safetensors") || "",
                );
                const refAccelAdapter = makeJsonLoraAdapter(
                    "video_ref_lora_data",
                    (name) => name.toLowerCase().includes("minimax_h3_ref2v_lightx2v_turbo_4step"),
                    loraModels.find((name) => name.toLowerCase().includes("minimax_h3_ref2v_lightx2v_turbo_4step")) || "",
                );
                const loraEntries = [
                    { label: "首帧参考 LoRA", folder: "loras", icon: "🟠", models: loraModels, defaultModel: nextSceneAdapter.value, getWidget: () => nextSceneAdapter, autoSelect: true },
                    { label: "Qwen2511 4-step 加速 LoRA", folder: "loras", icon: "⚡", models: loraModels, defaultModel: imageAccelAdapter.value, getWidget: () => imageAccelAdapter, autoSelect: true },
                    { label: "MiniMax-H3 REF2V 加速 LoRA", folder: "loras", icon: "⚡", models: loraModels, defaultModel: refAccelAdapter.value, getWidget: () => refAccelAdapter, autoSelect: true },
                ];
                const loraTree = GJJ_Utils.createModelTreeView({
                    node,
                    entries: loraEntries,
                    onApply: () => markChanged(node),
                });
                loraTreeHost.replaceChildren(loraTree);
            }).catch((error) => {
                loraTreeHost.textContent = `LoRA 目录树加载失败：${error?.message || error}`;
                loraTreeHost.style.color = "#db4a4a";
            });
        } catch (err) {
            const errDiv = document.createElement("div");
            errDiv.textContent = `模型树加载失败：${err.message}`;
            errDiv.style.color = "#db4a4a";
            float.appendChild(errDiv);
        }

        // LoRA 配置区域
        const loraSection = document.createElement("div");
        loraSection.style.cssText = "margin-top:10px;border-top:1px solid #2a3a40;padding-top:8px;";
        const loraLabel = document.createElement("div");
        loraLabel.textContent = "🔗 运行配置";
        loraLabel.style.cssText = "font:12px/1.4 system-ui;color:#cfe8e8;margin-bottom:4px;";
        loraSection.appendChild(loraLabel);

        // 保持模型开关
        const keepWidget = node.widgets?.find((w) => w.name === "keep_model");
        if (keepWidget) {
            const keepRow = document.createElement("div");
            keepRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:6px;";
            const keepInput = document.createElement("input");
            keepInput.type = "checkbox";
            keepInput.checked = !!keepWidget.value;
            keepInput.style.cssText = "accent-color:#4da6ff;";
            const keepLabel = document.createElement("span");
            keepLabel.textContent = "保持模型（不自动卸载）";
            keepLabel.style.cssText = "font:11px/1.4 system-ui;color:#aac0c8;";
            keepInput.addEventListener("change", () => {
                keepWidget.value = keepInput.checked;
                markChanged(node);
            });
            keepRow.append(keepInput, keepLabel);
            loraSection.appendChild(keepRow);
        }

        float.appendChild(loraSection);
        return float;
    }

    // ====== LoRA 选择器（简化版：模型树 + 插槽） ======

    function _parseLoraData(widgetValue) {
        try {
            const arr = JSON.parse(String(widgetValue || "[]"));
            if (Array.isArray(arr)) return arr;
        } catch (_) {}
        return [];
    }

    function _buildLoraWidgetValue(rows) {
        const arr = rows.filter(r => r?.name).map(r => ({
            enabled: true,
            name: String(r.name || ""),
            strength_model: parseFloat(r.strength ?? 1.0) || 1.0,
            strength_clip: parseFloat(r.strength ?? 1.0) || 1.0,
        }));
        return JSON.stringify(arr);
    }

    /**
     * 简化版 LoRA 选择器：一行按钮打开下拉选择 + 强度 + 删除
     */
    function _renderLoraPickerSimple(node, container, widgetName, label, icon, maxRows = 2) {
        const widget = node.widgets?.find((w) => w.name === widgetName);
        if (!widget) return;

        const section = document.createElement("div");
        section.style.cssText = "margin-top:6px;";

        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:3px;";
        header.append(
            Object.assign(document.createElement("span"), { textContent: icon, style: { fontSize: "12px" } }),
            Object.assign(document.createElement("span"), {
                textContent: label,
                style: "font:11px/1.4 system-ui;color:#aac0c8;",
            })
        );
        section.appendChild(header);

        // 插槽容器
        const slotsHost = document.createElement("div");
        slotsHost.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        section.appendChild(slotsHost);

        let loraRows = _parseLoraData(widget.value);
        if (loraRows.length === 0) loraRows.push({ name: "", strength: 1.0 });

        // 异步加载 LoRA 列表
        let allLoraNames = [];
        fetch("/gjj/loras").then(r => r.ok ? r.json() : null).then(data => {
            allLoraNames = (data?.loras || []).filter(f => f && !f.startsWith(".")).sort();
            renderAll();
        }).catch(() => { allLoraNames = []; });

        function renderAll() {
            if (loraRows.length === 0) loraRows.push({ name: "", strength: 1.0 });
            slotsHost.replaceChildren();

            loraRows.forEach((row, idx) => {
                const line = document.createElement("div");
                line.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 60px 20px;gap:4px;align-items:center;";

                // 选择按钮
                const picker = document.createElement("button");
                picker.type = "button";
                picker.textContent = row.name || "＋ 选择 LoRA";
                picker.title = "点击选择 LoRA 文件";
                picker.style.cssText = "min-width:0;height:24px;border:1px solid #415761;border-radius:5px;background:#111c21;color:#e9f4ef;padding:0 6px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;font:11px system-ui;";
                picker.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (!allLoraNames.length) {
                        alert("LoRA 列表还在加载中，请稍候重试。");
                        return;
                    }
                    const select = document.createElement("select");
                    select.style.cssText = "position:fixed;z-index:99999;font:12px system-ui;max-height:60vh;overflow:auto;";
                    const emptyOpt = document.createElement("option");
                    emptyOpt.value = ""; emptyOpt.textContent = "— 不使用 —";
                    select.append(emptyOpt);
                    allLoraNames.forEach((n) => {
                        const o = document.createElement("option");
                        o.value = n; o.textContent = n;
                        if (n === row.name) o.selected = true;
                        select.append(o);
                    });
                    document.body.appendChild(select);
                    select.focus();
                    select.addEventListener("change", () => {
                        loraRows[idx] = { name: select.value, strength: row.strength || 1.0 };
                        widget.value = _buildLoraWidgetValue(loraRows);
                        markChanged(node);
                        renderAll();
                        if (select.parentNode) select.parentNode.removeChild(select);
                    });
                    const closeHandler = (ev) => {
                        if (!select.contains(ev.target)) {
                            document.removeEventListener("mousedown", closeHandler, true);
                            if (select.parentNode) select.parentNode.removeChild(select);
                        }
                    };
                    setTimeout(() => document.addEventListener("mousedown", closeHandler, true), 10);
                });

                // 强度
                const strength = document.createElement("input");
                strength.type = "number";
                strength.step = "0.05";
                strength.min = "0";
                strength.max = "2";
                strength.value = row.strength || 1.0;
                strength.disabled = !row.name;
                strength.title = row.name ? "LoRA 强度" : "选择 LoRA 后可设置强度";
                strength.style.cssText = "width:100%;box-sizing:border-box;height:24px;border:1px solid #415761;border-radius:5px;background:#111c21;color:#e9f4ef;padding:0 5px;font:11px system-ui;";
                strength.addEventListener("change", () => {
                    loraRows[idx] = { name: row.name, strength: parseFloat(strength.value) || 1.0 };
                    widget.value = _buildLoraWidgetValue(loraRows);
                    markChanged(node);
                });

                // 删除
                const delBtn = document.createElement("button");
                delBtn.type = "button";
                delBtn.textContent = "✕";
                delBtn.style.cssText = "width:20px;height:24px;border:1px solid #415761;border-radius:5px;background:#1a2328;color:#e9f4ef;cursor:pointer;font:10px;padding:0;";
                delBtn.title = "删除此行";
                delBtn.addEventListener("click", () => {
                    if (loraRows.length <= 1) {
                        loraRows[0] = { name: "", strength: 1.0 };
                    } else {
                        loraRows.splice(idx, 1);
                    }
                    widget.value = _buildLoraWidgetValue(loraRows);
                    markChanged(node);
                    renderAll();
                });

                line.append(picker, strength, delBtn);
                slotsHost.appendChild(line);
            });

            // 添加按钮（限制最多 maxRows 个）
            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.textContent = loraRows.length >= maxRows ? `已达上限 ${maxRows} 个` : "＋ 添加 LoRA";
            addBtn.disabled = loraRows.length >= maxRows;
            addBtn.style.cssText = `width:100%;height:22px;border:1px dashed ${loraRows.length >= maxRows ? '#2a3a40' : '#415761'};border-radius:5px;background:transparent;color:${loraRows.length >= maxRows ? '#556670' : '#7fb3a8'};cursor:${loraRows.length >= maxRows ? 'not-allowed' : 'pointer'};font:11px system-ui;margin-top:2px;`;
            addBtn.addEventListener("click", () => {
                if (loraRows.length >= maxRows) return;
                loraRows.push({ name: "", strength: 1.0 });
                widget.value = _buildLoraWidgetValue(loraRows);
                markChanged(node);
                renderAll();
            });
            slotsHost.appendChild(addBtn);
        }

        renderAll();
        container.appendChild(section);
    }

    // ====== 参数设置浮动窗口 ======
    // 参数规格表（注册时从 nodeData.input 构建，default/min/max/values 的权威来源）
    // 注意：widget.options 在部分 ComfyUI 版本不保留这些字段，不能依赖
    let GJJ_SVG_WIDGET_SPECS = {};

    function buildParamFloat(node) {
        const float = createFloatShell("⚙️ 参数设置", "gjj-svg-param-float");

        // 一键重置：所有参数恢复默认值（终极兜底，保存后永久生效）
        const resetRow = document.createElement("div");
        resetRow.style.cssText = "display:flex;justify-content:flex-end;margin-bottom:6px;";
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.textContent = "↺ 重置参数为默认值";
        resetBtn.style.cssText = "padding:4px 10px;border:1px solid #7a5a3a;border-radius:5px;background:#2a1a10;color:#ffd9a0;cursor:pointer;font:700 11px system-ui;";
        resetBtn.title = "将所有参数恢复为默认值并保存，用于修复参数错乱";
        resetBtn.addEventListener("click", () => {
            for (const w of (node.widgets || [])) {
                if (!w || w.name === TABLE_WIDGET) continue;
                const spec = GJJ_SVG_WIDGET_SPECS[w.name];
                const def = spec?.default ?? w.options?.default;
                if (def !== undefined && def !== null) {
                    w.value = def;
                    if (w.element && !w.element.disabled && "value" in w.element) w.element.value = def;
                }
            }
            markChanged(node);
            // 关闭并重建参数浮窗，刷新显示
            closeAllFloats(node);
            const state = node.__gjjSvgPanel;
            const btn = state?.toolbar?.querySelector('button[title="参数设置"]');
            if (state && btn) {
                const f = buildParamFloat(node);
                if (f) {
                    f.dataset.node = String(node.id);
                    f.dataset.floatClass = "gjj-svg-param-float";
                    document.body.appendChild(f);
                    positionFloatNearButton(node, btn, f);
                    btn.classList.add("active");
                    btn.dataset.floatBtn = "1";
                }
            }
        });
        resetRow.appendChild(resetBtn);
        float.appendChild(resetRow);

        const paramWidgets = [
            "width", "height", "frame_rate", "seed", "randomize_seed",
            "keyframe_steps", "keyframe_cfg", "video_steps",
            "video_sampler", "video_scheduler",
            "chars_per_second", "max_shot_duration",
            "visual_style", "camera_motion", "dialogue_language",
            "format_name", "filename_prefix",
            "negative_prompt",
        ];
        const container = document.createElement("div");
        container.style.cssText = "display:flex;flex-direction:column;gap:6px;";
        for (const name of paramWidgets) {
            const widget = node.widgets?.find((w) => w.name === name);
            if (!widget) continue;
            const origType = widget.__gjjOrigType || widget.type;
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:flex-start;gap:6px;";
            const label = document.createElement("label");
            const displayName = widget.options?.display_name || widget.name;
            label.textContent = displayName;
            label.style.cssText = "min-width:110px;font:11px/1.2 system-ui;color:#aac0c8;padding-top:4px;";
            let input;
            const isMultiline = name === "negative_prompt";
            if (origType === "boolean" || (widget.options?.values && !isMultiline)) {
                input = document.createElement("select");
                const values = widget.options?.values || [true, false];
                for (const v of values) {
                    const opt = document.createElement("option");
                    opt.value = v;
                    opt.textContent = v;
                    if (String(widget.value) === String(v)) opt.selected = true;
                    input.appendChild(opt);
                }
                input.style.cssText = "flex:1;padding:2px 6px;border:1px solid #3a4a50;border-radius:4px;background:#1a2a30;color:#eef5f5;font:11px system-ui;";
                input.addEventListener("change", () => {
                    let val = input.value;
                    if (origType === "boolean") val = val === "true";
                    widget.value = val;
                    if (typeof widget.callback === "function") widget.callback(val);
                    markChanged(node);
                });
            } else if (isMultiline) {
                input = document.createElement("textarea");
                input.value = widget.value;
                input.style.cssText = "flex:1;padding:4px 6px;border:1px solid #3a4a50;border-radius:4px;background:#1a2a30;color:#eef5f5;font:11px system-ui;min-height:60px;resize:vertical;";
                input.addEventListener("change", () => {
                    widget.value = input.value;
                    if (typeof widget.callback === "function") widget.callback(input.value);
                    markChanged(node);
                });
            } else {
                input = document.createElement("input");
                input.type = origType === "number" || origType === "INT" || origType === "FLOAT" ? "number" : "text";
                input.value = widget.value;
                input.style.cssText = "flex:1;padding:2px 6px;border:1px solid #3a4a50;border-radius:4px;background:#1a2a30;color:#eef5f5;font:11px system-ui;";
                input.addEventListener("change", () => {
                    let val = input.value;
                    if (origType === "number" || origType === "INT" || origType === "FLOAT") {
                        val = parseFloat(val) || 0;
                    }
                    widget.value = val;
                    if (typeof widget.callback === "function") widget.callback(val);
                    markChanged(node);
                });
            }
            row.append(label, input);
            container.appendChild(row);
        }
        float.appendChild(container);
        return float;
    }

    // ====== 创建主面板 ======
    function createPanel(node) {
        // 宫格容器（独立 DOM widget，不依赖移动原生 widget）
        const gridRoot = document.createElement("div");
        gridRoot.className = "gjj-svg-root";
        gridRoot.__gjjNode = node;

        const style = document.createElement("style");
        style.textContent = `
        .gjj-svg-root { display:flex; flex-direction:column; gap:4px; padding:4px 0; font:12px/1.4 system-ui,sans-serif; color:#eef5f5; }
        .gjj-svg-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:3px; padding:4px 6px; background:#101e23; border:1px solid #2a3a40; border-radius:6px; }
        .gjj-svg-btn { min-width:32px; height:28px; padding:3px 7px; border:1px solid #3a4a50; border-radius:5px; background:#1a2a30; color:#cfe8e8; cursor:pointer; font:700 13px/1 system-ui,sans-serif; transition:background .15s,border-color .15s; display:inline-flex; align-items:center; justify-content:center; }
        .gjj-svg-btn:hover { background:#264558; border-color:#5a7a80; }
        .gjj-svg-btn.active { background:#1a4a3a; border-color:#3f7a65; color:#9be0b5; }
        .gjj-svg-btn:disabled { opacity:.5; cursor:not-allowed; }
        .gjj-svg-node-progress { display:none; flex-direction:column; gap:5px; padding:7px 9px; border:1px solid #31515a; border-radius:6px; background:rgba(9,24,29,.94); box-shadow:inset 0 0 14px rgba(47,139,151,.08); }
        .gjj-svg-node-progress-head { display:flex; align-items:center; gap:8px; min-width:0; }
        .gjj-svg-node-progress-text { flex:1; min-width:0; color:#dff7f5; font:700 11px/1.3 system-ui,sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .gjj-svg-node-progress-percent { color:#83dfcf; font:700 11px/1 system-ui,sans-serif; }
        .gjj-svg-node-progress-track { height:5px; overflow:hidden; border-radius:999px; background:rgba(127,168,178,.2); }
        .gjj-svg-node-progress-fill { width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#35c7a5,#4a9adb,#9f7aea); transition:width .2s ease; }
        .gjj-svg-node-progress-fill.indeterminate { animation:gjj-svg-node-progress-slide 1s ease-in-out infinite alternate; }
        @keyframes gjj-svg-node-progress-slide { from{width:18%;transform:translateX(0);} to{width:42%;transform:translateX(138%);} }
        .gjj-svg-sep { width:1px; height:20px; background:#2a3a40; margin:0 2px; }
        .gjj-svg-float { position:absolute; z-index:1001; top:36px; right:6px; width:min(440px,92%); max-height:520px; overflow:auto; padding:8px; border:1px solid #526a73; border-radius:8px; background:rgba(13,22,25,.98); box-shadow:0 12px 32px rgba(0,0,0,.58); }
        .gjj-svg-float-header { display:flex; align-items:center; gap:6px; padding-bottom:6px; border-bottom:1px solid rgba(82,106,115,.45); margin-bottom:6px; }
        .gjj-svg-float-header span { font:700 12px/1 system-ui; color:#cfe8e8; }
        .gjj-svg-float-close { margin-left:auto; padding:2px 8px; border:1px solid #3a4a50; border-radius:4px; background:#1a2a30; color:#cfe8e8; cursor:pointer; }
        .gjj-svg-float-close:hover { background:#264558; }
        .gjj-svg-grid { display:none; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:8px; row-gap:14px; align-items:start; padding:6px; min-height:0; max-height:620px; overflow-y:auto; background:#0a1216; border:1px solid #1e2a30; border-radius:6px; }
        .gjj-svg-cell { position:relative; isolation:isolate; width:100%; min-width:0; aspect-ratio:4/3; box-sizing:border-box; border:1px solid #2a3a40; border-radius:7px; overflow:hidden; background:#101e23; cursor:pointer; transition:border-color .15s, box-shadow .15s; display:block; align-self:start; }
        .gjj-svg-cell:hover { border-color:#4a6a70; }
        .gjj-svg-cell.selected { border-color:#ffd166; box-shadow:0 0 0 2px rgba(255,209,102,.35); }
        .gjj-svg-cell.generating { border-color:#4a9adb; animation:gjj-svg-pulse 1.2s infinite; }
        .gjj-svg-cell.done { border-color:#3f7a65; }
        .gjj-svg-cell.error { border-color:#db4a4a; }
        @keyframes gjj-svg-pulse { 0%,100%{opacity:1;} 50%{opacity:.6;} }
        .gjj-svg-cell-preview { position:absolute; inset:0; width:100%; height:100%; background:#0a1216; overflow:hidden; }
        .gjj-svg-cell-preview canvas, .gjj-svg-cell-preview video { width:100%; height:100%; object-fit:contain; position:absolute; top:0; left:0; }
        .gjj-svg-cell-preview canvas { transition:opacity .2s; }
        .gjj-svg-cell-play { position:absolute; z-index:8; left:50%; top:50%; transform:translate(-50%,-50%); width:46px; height:46px; place-items:center; padding:0 0 0 2px; border:1px solid rgba(180,231,235,.78); border-radius:50%; background:rgba(3,15,20,.72); color:#fff; cursor:pointer; font:20px/1 system-ui; box-shadow:0 5px 18px rgba(0,0,0,.55); backdrop-filter:blur(5px); transition:transform .15s,background .15s; }
        .gjj-svg-cell-play:hover { transform:translate(-50%,-50%) scale(1.08); background:rgba(24,93,105,.88); }
        .gjj-svg-video-overlay { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.92); backdrop-filter:blur(8px); }
        .gjj-svg-video-player { max-width:94vw; max-height:90vh; object-fit:contain; border-radius:8px; background:#000; box-shadow:0 16px 52px rgba(0,0,0,.72); }
        .gjj-svg-video-player-title { position:absolute; left:50%; top:16px; transform:translateX(-50%); padding:6px 12px; border-radius:999px; background:rgba(0,0,0,.62); color:#fff; font:12px/1.3 system-ui,'Microsoft YaHei',sans-serif; pointer-events:none; }
        .gjj-svg-cell-progress { position:absolute; z-index:7; left:50%; top:50%; transform:translate(-50%,-50%); width:min(72%,220px); box-sizing:border-box; flex-direction:column; gap:7px; padding:9px 11px; border:1px solid rgba(144,205,224,.62); border-radius:8px; background:rgba(3,12,16,.78); backdrop-filter:blur(5px); box-shadow:0 5px 18px rgba(0,0,0,.5); pointer-events:none; }
        .gjj-svg-cell-progress-label { color:#f2fbff; text-align:center; font:700 11px/1.25 system-ui,sans-serif; text-shadow:0 1px 2px #000; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .gjj-svg-cell-progress-track { height:4px; overflow:hidden; border-radius:999px; background:rgba(137,178,191,.24); }
        .gjj-svg-cell-progress-fill { width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#43c6ac,#4a9adb); transition:width .2s ease; }
        .gjj-svg-cell-progress-fill.indeterminate { animation:gjj-svg-progress-slide 1s ease-in-out infinite alternate; }
        @keyframes gjj-svg-progress-slide { from{width:18%;transform:translateX(0);} to{width:42%;transform:translateX(138%);} }
        .gjj-svg-cell-info { position:absolute; z-index:9; left:6px; right:6px; bottom:30px; display:flex; align-items:center; gap:5px; padding:3px 6px; border-radius:5px; background:rgba(4,12,15,.76); backdrop-filter:blur(3px); font:700 11px/1.2 system-ui,sans-serif; pointer-events:none; }
        .gjj-svg-cell-index { color:#b8f5ce; text-shadow:0 1px 2px #000; }
        .gjj-svg-cell-duration { color:#e4f0f2; text-shadow:0 1px 2px #000; }
        .gjj-svg-cell-status { margin-left:auto; font-size:12px; }
        .gjj-svg-cell-refs { position:absolute !important; z-index:5; top:6px; left:6px; right:72px; padding:0 !important; min-height:0 !important; filter:drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
        .gjj-svg-cell-prompt { position:absolute; z-index:10; left:0; right:0; bottom:0; height:30px; box-sizing:border-box; padding:7px 8px 5px; background:rgba(2,8,10,.92); border-top:1px solid rgba(104,151,160,.35); cursor:text; }
        .gjj-svg-cell-prompt-text { font:700 11px/1.3 system-ui,sans-serif; color:#f0f7f7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; text-shadow:0 1px 2px #000; }
        .gjj-svg-cell-prompt-text:hover { color:#ffd166; }
        .gjj-svg-cell-toolbar { position:absolute; z-index:6; top:6px; right:6px; display:flex; gap:4px; padding:0; }
        .gjj-svg-cell-btn { width:28px; height:26px; flex:0 0 28px; padding:0; border:1px solid rgba(130,164,174,.72); border-radius:5px; background:rgba(8,22,27,.76); color:#fff; cursor:pointer; font:13px/1 system-ui; transition:background .15s,transform .15s; backdrop-filter:blur(3px); box-shadow:0 1px 3px rgba(0,0,0,.55); }
        .gjj-svg-cell-btn:hover { transform:translateY(-1px); }
        .gjj-svg-cell-btn:hover { background:#264558; }
        .gjj-svg-keyframe-btn { border-color:#3a5a60; }
        .gjj-svg-keyframe-btn:hover { background:#1a3a30; }
        .gjj-svg-video-btn { border-color:#4a3a5a; }
        .gjj-svg-video-btn:hover { background:#3a1a30; }
        .gjj-svg-video-btn.ready { border-color:#39b982; background:rgba(16,98,69,.88); }
        .gjj-svg-video-btn.ready:hover { background:#16845c; }
        .gjj-svg-video-btn:disabled { cursor:wait; opacity:.72; transform:none; }
        .gjj-svg-empty { width:100%; padding:20px; text-align:center; color:#75868b; }
        .gjj-svg-edit-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,.6); z-index:2000; display:flex; align-items:center; justify-content:center; }
        .gjj-svg-edit-modal { width:min(500px,90vw); max-height:80vh; background:#10181c; border:1px solid #526a73; border-radius:10px; box-shadow:0 16px 48px rgba(0,0,0,.6); display:flex; flex-direction:column; }
        .gjj-svg-edit-header { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid #2a3a40; }
        .gjj-svg-edit-header span { font:700 13px/1 system-ui; color:#cfe8e8; }
        .gjj-svg-edit-close { margin-left:auto; padding:4px 10px; border:1px solid #3a4a50; border-radius:5px; background:#1a2a30; color:#cfe8e8; cursor:pointer; }
        .gjj-svg-edit-close:hover { background:#264558; }
        .gjj-svg-edit-body { padding:12px 14px; display:flex; flex-direction:column; gap:8px; overflow-y:auto; }
        .gjj-svg-edit-body label { font:11px/1.2 system-ui; color:#aac0c8; display:block; margin-bottom:2px; }
        .gjj-svg-edit-body textarea { width:100%; min-height:50px; padding:6px 8px; border:1px solid #334850; border-radius:5px; background:#0a1216; color:#eef5f5; font:12px/1.4 system-ui; font-family:ui-monospace,Consolas,monospace; box-sizing:border-box; outline:none; resize:vertical; }
        .gjj-svg-edit-body textarea:focus { border-color:#6a9dae; }
        .gjj-svg-edit-footer { display:flex; gap:8px; padding:10px 14px; border-top:1px solid #2a3a40; }
        .gjj-svg-edit-footer button { padding:6px 16px; border:1px solid #3a4a50; border-radius:5px; background:#1a2a30; color:#cfe8e8; cursor:pointer; font:12px/1 system-ui; }
        .gjj-svg-edit-footer button:hover { background:#264558; }
        .gjj-svg-edit-save { background:#1a4a3a !important; border-color:#3f7a65 !important; color:#9be0b5 !important; }
        .gjj-svg-edit-save:hover { background:#2a5a4a !important; }
        `;
        gridRoot.appendChild(style);

        // 顶部工具栏
        const toolbar = document.createElement("div");
        toolbar.className = "gjj-svg-toolbar";

        const modelBtn = document.createElement("button");
        modelBtn.type = "button";
        modelBtn.className = "gjj-svg-btn";
        modelBtn.textContent = "🧠";
        modelBtn.title = "模型配置";
        modelBtn.addEventListener("click", () => toggleFloat(node, "gjj-svg-model-float", () => buildModelFloat(node), modelBtn));

        const paramBtn = document.createElement("button");
        paramBtn.type = "button";
        paramBtn.className = "gjj-svg-btn";
        paramBtn.textContent = "⚙️";
        paramBtn.title = "参数设置";
        paramBtn.dataset.floatBtn = "param";
        paramBtn.addEventListener("click", () => toggleFloat(node, "gjj-svg-param-float", () => buildParamFloat(node), paramBtn));

        const sizeBtn = document.createElement("button");
        sizeBtn.type = "button";
        sizeBtn.className = "gjj-svg-btn";
        sizeBtn.textContent = "📐";
        sizeBtn.title = "尺寸与画幅比例";
        sizeBtn.addEventListener("click", () => toggleFloat(node, "gjj-svg-size-float", () => buildSizeFloat(node), sizeBtn));

        const clearSelBtn = document.createElement("button");
        clearSelBtn.type = "button";
        clearSelBtn.className = "gjj-svg-btn";
        clearSelBtn.textContent = "✖";
        clearSelBtn.title = "取消选择";
        clearSelBtn.addEventListener("click", () => {
            const state = node.__gjjSvgPanel;
            if (state?.grid) {
                state.grid.querySelectorAll(".gjj-svg-cell.selected").forEach((c) => c.classList.remove("selected"));
                lastSelectedCellId = -1;
                updateSelectedIndices(node);
            }
        });

        const sep2 = document.createElement("span");
        sep2.className = "gjj-svg-sep";

        const runBtn = document.createElement("button");
        runBtn.type = "button";
        runBtn.className = "gjj-svg-btn";
        runBtn.textContent = "▶️";
        runBtn.title = "图片与视频生成";
        runBtn.addEventListener("click", () => toggleFloat(node, "gjj-svg-run-float", () => buildRunFloat(node), runBtn));

        const linkBtn = document.createElement("button");
        linkBtn.type = "button";
        linkBtn.className = "gjj-svg-btn";
        linkBtn.style.display = "none";
        linkBtn.addEventListener("click", () => toggleUpstreamTableLink(node));

        toolbar.append(modelBtn, paramBtn, sizeBtn, clearSelBtn, sep2, linkBtn, runBtn);
        gridRoot.appendChild(toolbar);

        const progressPanel = document.createElement("div");
        progressPanel.className = "gjj-svg-node-progress";
        const progressHead = document.createElement("div");
        progressHead.className = "gjj-svg-node-progress-head";
        const progressText = document.createElement("div");
        progressText.className = "gjj-svg-node-progress-text";
        const progressPercent = document.createElement("div");
        progressPercent.className = "gjj-svg-node-progress-percent";
        progressHead.append(progressText, progressPercent);
        const progressTrack = document.createElement("div");
        progressTrack.className = "gjj-svg-node-progress-track";
        const progressFill = document.createElement("div");
        progressFill.className = "gjj-svg-node-progress-fill";
        progressTrack.appendChild(progressFill);
        progressPanel.append(progressHead, progressTrack);
        gridRoot.appendChild(progressPanel);

        // 宫格预览区
        const grid = document.createElement("div");
        grid.className = "gjj-svg-grid";
        gridRoot.appendChild(grid);

        const floatHost = document.createElement("div");
        floatHost.style.position = "relative";
        gridRoot.appendChild(floatHost);

        const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", gridRoot, {
            serialize: false,
            hideOnZoom: false,
        });
        domWidget.computeSize = (width) => {
            const toolbarH = Number(toolbar.offsetHeight || 32);
            const progressH = progressPanel.style.display === "none" ? 0 : Number(progressPanel.offsetHeight || 40) + 4;
            const gridH = grid.style.display === "none" ? 0 : Number(grid.offsetHeight || 0);
            return [Math.max(440, Number(width || node.size?.[0] || 440)), Math.max(40, toolbarH + progressH + gridH + 8)];
        };

        node.__gjjSvgPanel = {
            root: gridRoot, domWidget, toolbar, linkBtn, grid, floatHost,
            progressPanel, progressText, progressPercent, progressFill, progressHideTimer: null,
            shots: [], totalCells: 0, generating: false,
        };
        if (!node.__gjjStoryboardLinkWatcher) {
            const originalConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (...args) {
                const result = originalConnectionsChange?.apply(this, args);
                queueMicrotask(() => syncUpstreamLinkButton(this));
                return result;
            };
            node.__gjjStoryboardLinkWatcher = true;
        }
        queueMicrotask(() => syncUpstreamLinkButton(node));

        return gridRoot;
    }

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;

            // 图片预览完全由分镜宫格的逐格预览管理；关闭 ComfyUI 对 IMAGE
            // 输出的原生节点底部预览，避免旧输出另画一张错位的大图。
            nodeData.output_preview = false;
            if (Array.isArray(nodeData.outputs)) {
                for (const output of nodeData.outputs) output.preview = false;
            }

            // ===== 构建参数规格表（default/min/max/values 的权威来源）=====
            // nodeData.input = { required: {...}, optional: {...}, hidden: {...} }
            // 每个条目: [typeOrValues, options]，例如 ["INT", {default:864,min:352,max:1920}]
            try {
                const specs = {};
                const sections = [nodeData?.input?.required, nodeData?.input?.optional, nodeData?.input?.hidden];
                for (const section of sections) {
                    if (!section || typeof section !== "object") continue;
                    for (const [name, entry] of Object.entries(section)) {
                        if (!Array.isArray(entry)) continue;
                        const typeOrValues = entry[0];
                        const opts = (entry[1] && typeof entry[1] === "object") ? entry[1] : {};
                        const spec = { default: opts.default, min: opts.min, max: opts.max, step: opts.step };
                        if (Array.isArray(typeOrValues)) spec.values = typeOrValues;
                        specs[name] = spec;
                    }
                }
                if (Object.keys(specs).length > 0) GJJ_SVG_WIDGET_SPECS = specs;
            } catch (e) {
                console.warn("[GJJ StoryboardVideoGrid] 构建参数规格表失败", e);
            }

            // ===== onNodeCreated：新节点初始化面板 =====
            const originalOnCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = originalOnCreated?.call(this);
                this.__gjjSvgInited = false;
                _initPanel(this);
                return result;
            };

            // Node-local completion hook is more reliable for long batch jobs
            // than relying only on the global websocket event.
            const originalOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                const result = originalOnExecuted?.call(this, message);
                const records = normalizedVideoRecords(message?.storyboard_videos);
                const standardVideos = [message?.videos, message?.gifs, message?.preview_video, message?.preview_media];
                const node = this;
                setTimeout(() => {
                    if (records.length) applyVideoRecords(node, records, records.length);
                    else applyStandardVideoItems(node, standardVideos);
                }, 0);
                return result;
            };

            // Persist widget values by name. ComfyUI's legacy widgets_values
            // array is positional, so appended optional inputs otherwise shift
            // values when an older workflow is reopened.
            const originalOnSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (nodeData) {
                const result = originalOnSerialize?.call(this, nodeData);
                const named = {};
                for (const widget of (this.widgets || [])) {
                    if (!widget?.name || !(widget.name in GJJ_SVG_WIDGET_SPECS)) continue;
                    named[widget.name] = widget.value;
                }
                nodeData.properties = nodeData.properties || {};
                nodeData.properties._gjj_named_widgets_v2 = named;
                nodeData.properties.gjj_svg_width = Number(widgetValue(this, "width", 1024));
                nodeData.properties.gjj_svg_height = Number(widgetValue(this, "height", 768));
                return result;
            };

            // ===== onConfigure：工作流加载（简单可靠，不再做位置补偿/命名值）=====
            const originalOnConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (nodeData) {
                const namedV2 = nodeData?.properties?._gjj_named_widgets_v2;
                // 清理旧版本残留的命名值缓存（防止损坏值自我延续）
                try {
                    if (nodeData?.properties) delete nodeData.properties["_gjj_named_widgets_v1"];
                    if (this.properties) delete this.properties["_gjj_named_widgets_v1"];
                } catch (_) {}

                // 执行原始 onConfigure（ComfyUI 按位置映射 widgets_values）
                const result = originalOnConfigure?.call(this, nodeData);

                if (namedV2 && typeof namedV2 === "object") {
                    for (const widget of (this.widgets || [])) {
                        if (widget?.name && Object.prototype.hasOwnProperty.call(namedV2, widget.name)) {
                            widget.value = namedV2[widget.name];
                        }
                    }
                }
                const savedWidth = Number(nodeData?.properties?.gjj_svg_width);
                const savedHeight = Number(nodeData?.properties?.gjj_svg_height);
                if (Number.isFinite(savedWidth)) setWidgetValue(this, "width", savedWidth);
                if (Number.isFinite(savedHeight)) setWidgetValue(this, "height", savedHeight);

                // 加载后统一修复无效值（空值/超范围/无效COMBO → 回退默认值）
                _fixLegacyModelValues(this);

                // Qwen2511 Lightning image generation must stay identical to
                // GJJ_StoryboardGridGenerator's 4-step / CFG 1 preset.
                const imageStepsWidget = this.widgets?.find((w) => w.name === "keyframe_steps");
                const imageCfgWidget = this.widgets?.find((w) => w.name === "keyframe_cfg");
                if (imageStepsWidget) imageStepsWidget.value = 4;
                if (imageCfgWidget) imageCfgWidget.value = 1.0;

                // Repair the confirmed legacy positional shift where the
                // dialogue language was restored into the image negative text.
                const negativeWidget = this.widgets?.find((w) => w.name === "negative_prompt");
                const languageValues = GJJ_SVG_WIDGET_SPECS.dialogue_language?.values || [];
                if (negativeWidget && languageValues.some((value) => String(value) === String(negativeWidget.value))) {
                    console.log("[GJJ StoryboardVideoGrid] 修复负面提示词错位", negativeWidget.value);
                    negativeWidget.value = GJJ_SVG_WIDGET_SPECS.negative_prompt?.default ?? "";
                }

                this.__gjjSvgInited = false;
                _initPanel(this);
                return result;
            };

            function _fixLegacyModelValues(node) {
                // 修复所有 widget 的无效值（基于注册时的权威规格表 GJJ_SVG_WIDGET_SPECS）
                for (const widget of (node.widgets || [])) {
                    if (!widget || widget.name === TABLE_WIDGET) continue;
                    const spec = GJJ_SVG_WIDGET_SPECS[widget.name] || {};
                    const curVal = widget.value;

                    // BOOLEAN 类型：值必须是 true/false，否则回退默认
                    if (typeof spec.default === "boolean") {
                        if (typeof curVal !== "boolean") {
                            widget.value = spec.default;
                            console.log("[GJJ StoryboardVideoGrid] 修复布尔值", { widget: widget.name, old: curVal, new: spec.default });
                        }
                        continue;
                    }

                    // COMBO 类型：检查值是否在选项列表中
                    if (Array.isArray(spec.values) && spec.values.length > 0) {
                        const curStr = String(curVal ?? "");
                        const matchFound = spec.values.some((o) => String(o) === curStr);
                        if (!curStr || !matchFound) {
                            const def = spec.default != null ? String(spec.default) : "";
                            const newVal = def && spec.values.some((o) => String(o) === def) ? def : String(spec.values[0]);
                            if (newVal !== curStr) {
                                widget.value = newVal;
                                console.log("[GJJ StoryboardVideoGrid] 修复COMBO值", { widget: widget.name, old: curStr || "(空)", new: newVal });
                            }
                        }
                        continue;
                    }

                    // INT / FLOAT 类型：空值回退默认，超范围钳制
                    if (spec.min != null || spec.max != null || typeof spec.default === "number") {
                        try {
                            // 空值/缺失 → 直接回退默认值
                            if (curVal === "" || curVal == null) {
                                if (spec.default != null) {
                                    widget.value = spec.default;
                                    console.log("[GJJ StoryboardVideoGrid] 空值回退默认", { widget: widget.name, new: spec.default });
                                }
                                continue;
                            }
                            const numVal = Number(curVal);
                            if (Number.isFinite(numVal)) {
                                let fixed = false;
                                let newVal = numVal;
                                if (spec.min != null && numVal < spec.min) {
                                    newVal = Number(spec.min);
                                    fixed = true;
                                }
                                if (spec.max != null && numVal > spec.max) {
                                    newVal = Number(spec.max);
                                    fixed = true;
                                }
                                if (fixed && spec.step != null && spec.step > 1) {
                                    const min = spec.min ?? 0;
                                    newVal = min + Math.round((newVal - min) / spec.step) * spec.step;
                                }
                                if (fixed) {
                                    widget.value = newVal;
                                    console.log("[GJJ StoryboardVideoGrid] 修复数值范围", { widget: widget.name, old: numVal, new: newVal, min: spec.min, max: spec.max });
                                }
                            } else {
                                // 无法转为数字（NaN），重置为默认值
                                if (spec.default != null && spec.default !== curVal) {
                                    widget.value = spec.default;
                                    console.log("[GJJ StoryboardVideoGrid] 修复无效数值", { widget: widget.name, old: curVal, new: spec.default });
                                }
                            }
                        } catch (_) {
                            if (spec.default != null) widget.value = spec.default;
                        }
                    }
                }
            }

            // 动态初始化默认 LoRA（如果为空或 "[]"）
            async function _initDefaultLoraIfNeeded(node) {
                try {
                    const kfLoraWidget = node.widgets?.find((w) => w.name === "keyframe_lora_data");
                    const refLoraWidget = node.widgets?.find((w) => w.name === "video_ref_lora_data");

                    // 检查是否需要初始化
                    const kfLoraVal = String(kfLoraWidget?.value ?? "");

                    const needsKeyframeLora = !kfLoraVal || kfLoraVal === "[]";
                    const refLoraVal = String(refLoraWidget?.value ?? "");
                    const needsRefLora = !refLoraVal || refLoraVal === "[]";

                    // 动态加载 LoRA 列表
                    const response = await fetch("/gjj/loras");
                    if (!response.ok) return false;
                    const data = await response.json();
                    const loraList = (Array.isArray(data) ? data : (data?.loras || [])).filter((n) => n && String(n).trim());

                    let updated = false;

                    if (refLoraWidget) {
                        const matched = loraList.filter((n) => {
                            const name = String(n).toLowerCase();
                            return name.includes("minimax_h3_ref2v_lightx2v_turbo_4step");
                        }).sort((a, b) => {
                            const a4 = String(a).toLowerCase().includes("4step") ? 0 : 1;
                            const b4 = String(b).toLowerCase().includes("4step") ? 0 : 1;
                            return a4 - b4 || String(a).length - String(b).length;
                        });
                        const currentRefLora = String(refLoraWidget.value ?? "");
                        const currentRows = _parseLoraData(currentRefLora).filter((row) => {
                            const name = String(row?.name || "").toLowerCase();
                            return !name.includes("minimax_h3_ref2v");
                        });
                        if (matched.length) {
                            currentRows.unshift({
                                enabled: true,
                                name: matched[0],
                                strength_model: 1.0,
                                strength_clip: 1.0,
                            });
                            const nextRefLora = JSON.stringify(currentRows);
                            if (nextRefLora !== currentRefLora) {
                                refLoraWidget.value = nextRefLora;
                                console.log("[GJJ StoryboardVideoGrid] 对齐默认 REF2V 加速 LoRA", matched[0]);
                                updated = true;
                            }
                        }
                    }

                    // 首帧 LoRA：匹配 qwen2511 相关 —— 最多 2 个（next-scene + lightning）
                    if (kfLoraWidget) {
                        const matched = loraList.filter((n) => {
                            const name = String(n).toLowerCase();
                            return (name.includes("qwen") && name.includes("2511") && name.includes("lora")) ||
                                   name.includes("next-scene") || name.includes("image-edit");
                        });
                        const exactAccel = loraList.find((name) =>
                            String(name).replaceAll("\\", "/").split("/").pop().toLowerCase()
                            === "qwen-image-edit-2511-lightning-4steps-v1.0-bf16.safetensors"
                        );
                        let restoredRows = _parseLoraData(kfLoraWidget.value).filter((row) => {
                            const name = String(row?.name || "").toLowerCase();
                            return !(name.includes("lightning") && !name.includes("2511"));
                        });
                        const nextScene = loraList.find((name) => String(name).toLowerCase().includes("next-scene_lora-v2-3000"));
                        if (nextScene && !restoredRows.some((row) => String(row?.name || "").toLowerCase().includes("next-scene"))) {
                            restoredRows.unshift({ enabled: true, name: nextScene, strength: 1.0 });
                        }
                        if (exactAccel && !restoredRows.some((row) => String(row?.name || "").toLowerCase().includes("2511-lightning-4steps"))) {
                            restoredRows.push({ enabled: true, name: exactAccel, strength: 1.0 });
                        }
                        restoredRows.sort((left, right) => {
                            const score = (row) => {
                                const name = String(row?.name || "").toLowerCase();
                                return name.includes("2511-lightning-4steps") ? 0 : name.includes("next-scene") ? 1 : 2;
                            };
                            return score(left) - score(right);
                        });
                        const currentKeyframeLora = String(kfLoraWidget.value ?? "");
                        if (restoredRows.length) {
                            const loraConfig = JSON.stringify(restoredRows);
                            if (loraConfig !== currentKeyframeLora) {
                                kfLoraWidget.value = loraConfig;
                                console.log("[GJJ StoryboardVideoGrid] 修复首帧加速 LoRA 为 Qwen2511 4-step", exactAccel);
                                updated = true;
                            }
                        } else if (matched.length > 0 && (!currentKeyframeLora || currentKeyframeLora === "[]")) {
                            // 排序：next-scene 优先 → lightning → 其他
                            matched.sort((a, b) => {
                                const aName = String(a).toLowerCase();
                                const bName = String(b).toLowerCase();
                                const aScore = aName.includes("next-scene") ? 0 : aName.includes("lightning") ? 1 : 2;
                                const bScore = bName.includes("next-scene") ? 0 : bName.includes("lightning") ? 1 : 2;
                                return aScore - bScore;
                            });
                            // 最多选 2 个
                            const selected = [];
                            const nextScene = matched.find(n => String(n).toLowerCase().includes("next-scene"));
                            if (nextScene) selected.push(nextScene);
                            const lightning = matched.find(n => String(n).toLowerCase().includes("lightning") && !String(n).toLowerCase().includes("next-scene"));
                            if (lightning) selected.push(lightning);
                            if (selected.length === 0) selected.push(matched[0]);
                            const loraConfig = JSON.stringify(selected.map(name => ({
                                enabled: true,
                                name,
                                strength_model: 1.0,
                                strength_clip: 1.0,
                            })));
                            kfLoraWidget.value = loraConfig;
                            console.log("[GJJ StoryboardVideoGrid] 初始化默认首帧 LoRA", selected);
                            updated = true;
                        }
                    }
                    return updated;
                } catch (err) {
                    // 静默失败，不影响主流程
                    console.debug("[GJJ StoryboardVideoGrid] LoRA 初始化跳过", err);
                    return false;
                }
            }

            function _initPanel(node) {
                if (node.__gjjSvgInited) return;
                const self = node;
                enforceSingleVideoOutput(self);

                // 强制让 storyboard_table 原生 widget 可见、可调大小
                const forceWidgetVisible = () => {
                    const tableWidget = self.widgets?.find((w) => w.name === TABLE_WIDGET);
                    if (!tableWidget) return;
                    const connected = storyboardTableIsConnected(self);
                    if (connected) {
                        tableWidget.hidden = true;
                        tableWidget.computeSize = () => [0, -4];
                        tableWidget.getHeight = () => 0;
                        tableWidget.computedHeight = 0;
                        for (const el of [tableWidget.widget, tableWidget.element, tableWidget.inputEl]) {
                            if (el?.style) el.style.display = "none";
                        }
                        return;
                    }
                    tableWidget.hidden = false;
                    try { tableWidget.disabled = false; } catch (_) {}
                    // 不要修改 type——MultilineTextWidget 需要保持原类型才能支持多行
                    delete tableWidget.options?.hidden;
                    delete tableWidget.options?.display;
                    const h = 160;
                    tableWidget.computeSize = (width) => [Math.max(260, Number(width || self.size?.[0] || 360)), h];
                    tableWidget.getHeight = () => h;
                    tableWidget.computedHeight = h;
                    tableWidget.size = [Math.max(260, Number(self.size?.[0] || 360)), h];
                    for (const el of [tableWidget.widget, tableWidget.element, tableWidget.inputEl]) {
                        if (!el?.style) continue;
                        el.style.removeProperty("display");
                        el.style.removeProperty("margin");
                    }
                    if (tableWidget.element?.style) {
                        tableWidget.element.style.minHeight = "140px";
                        tableWidget.element.style.maxHeight = "260px";
                        tableWidget.element.style.resize = "vertical";
                        tableWidget.element.style.background = "#0a1216";
                        tableWidget.element.style.border = "1px solid #334850";
                        tableWidget.element.style.borderRadius = "6px";
                        tableWidget.element.style.padding = "6px 8px";
                        tableWidget.element.style.color = "#eef5f5";
                        tableWidget.element.style.font = "12px/1.45 ui-monospace, Consolas, monospace";
                        tableWidget.element.style.outline = "none";
                        tableWidget.element.style.whiteSpace = "pre";
                        tableWidget.element.style.wordBreak = "break-all";
                    }
                    if (tableWidget.inputEl?.style) {
                        tableWidget.inputEl.style.minHeight = "140px";
                        tableWidget.inputEl.style.display = "block";
                    }
                };
                self.__gjjSvgSyncTableVisibility = forceWidgetVisible;

                // 隐藏除 storyboard_table 外的所有 widget
                // 辅助参数：type="hidden"（和 Python 端 "hidden":True 对应）
                // 主参数：只隐藏 DOM + 标记 hidden，保持原始类型（width/height/COMBO 等需要正常传递值）
                const ALWAYS_HIDDEN = new Set([
                    "single_cell_index", "single_cell_total", "selected_cell_indices",
                    "storyboard_full_table", "force_generate_all", "storyboard_preview_images",
                ]);

                // 动态初始化默认 LoRA（如果为空）
                _initDefaultLoraIfNeeded(self).then((updated) => {
                    if (updated) {
                        // LoRA 已更新，重新渲染模型面板
                        const modelPanel = document.getElementById(`gjj-model-panel-${self.id}`);
                        if (modelPanel) {
                            buildModelFloat(self);
                        }
                    }
                });

                for (const w of self.widgets || []) {
                    if (w.name === TABLE_WIDGET) continue;
                    w.__gjjOrigType = w.type;
                    w.serialize = true;
                    w.hidden = true;
                    w.options ||= {};
                    w.options.hidden = true;
                    w.computeSize = () => [0, -4];
                    w.getHeight = () => 0;
                    w.draw = () => {};
                    w.mouse = () => false;
                    if (ALWAYS_HIDDEN.has(w.name)) {
                        // 这些字段虽不显示，但必须参与 prompt 序列化；disabled
                        // 会让 ComfyUI 丢弃 keyframe_only、选中格与预览缓存值，
                        // 进而误启动视频阶段或复用错误宫格。
                        try { w.disabled = false; } catch (_) {}
                        w.type = "hidden";
                        w.options.display = "hidden";
                    }
                    // 所有 widget 都隐藏 DOM
                    if (w.widget) w.widget.style.display = "none";
                    if (w.element) w.element.style.display = "none";
                    if (w.inputEl) w.inputEl.style.display = "none";
                }

                requestAnimationFrame(() => {
                    forceWidgetVisible();
                    const tableWidget = self.widgets?.find((w) => w.name === TABLE_WIDGET);
                    if (tableWidget && !tableWidget.__gjjSvgPatched) {
                        // 阻止 widget.value setter → callback → 再次 setter 的死循环
                        let suppressCallback = false;
                        const origCallback = tableWidget.callback;
                        tableWidget.callback = function (value) {
                            if (suppressCallback) return;
                            suppressCallback = true;
                            try {
                                if (typeof origCallback === "function") {
                                    try { origCallback.call(self, value); } catch (_) {}
                                }
                                renderGrid(self);
                                markChanged(self);
                            } finally {
                                suppressCallback = false;
                            }
                        };
                        // 监听 element input：只渲染，不写回 widget.value（避免死循环）
                        if (tableWidget.element && !tableWidget.element.__gjjSvgInputBound) {
                            tableWidget.element.addEventListener("input", () => {
                                renderGrid(self);
                                markChanged(self);
                            });
                            tableWidget.element.addEventListener("change", () => {
                                renderGrid(self);
                                markChanged(self);
                            });
                            tableWidget.element.__gjjSvgInputBound = true;
                        }
                        tableWidget.__gjjSvgPatched = true;
                    }
                    if (!self.__gjjSvgPanel) {
                        createPanel(self);
                    }
                    ensureCurrentKeyframeLayoutVersion(self);
                    if (Array.isArray(self.widgets)) {
                        const order = [TABLE_WIDGET, PANEL_WIDGET];
                        self.widgets.sort((a, b) => {
                            const ai = order.indexOf(a.name);
                            const bi = order.indexOf(b.name);
                            if (ai >= 0 && bi >= 0) return ai - bi;
                            if (ai >= 0) return -1;
                            if (bi >= 0) return 1;
                            return 0;
                        });
                    }
                    renderGrid(self);
                    scheduleCompactEmptyNode(self);
                    self.__gjjSvgInited = true;
                });
            }

            // 连接变化时重新渲染（外接输入变化）
            const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, index, connected, links) {
                const result = originalOnConnectionsChange?.call(this, type, index, connected, links);
                const self = this;
                // 如果 storyboard_table 的连接变化，延迟一帧重新渲染
                const tableWidget = self.widgets?.find((w) => w.name === TABLE_WIDGET);
                if (tableWidget && self.__gjjSvgPanel) {
                    requestAnimationFrame(() => {
                        self.__gjjSvgSyncTableVisibility?.();
                        renderGrid(self);
                        markChanged(self);
                    });
                }
                return result;
            };

            const originalOnRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                closeCharacterViewPicker(this);
                const state = this.__gjjSvgPanel;
                if (state) {
                    state.floatHost?.replaceChildren();
                    state.grid?.replaceChildren();
                    this.__gjjSvgPanel = null;
                }
                return originalOnRemoved?.call(this);
            };
        },

        async setup() {
            const rerenderReferenceIcons = () => {
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (nodeClass === NODE_CLASS_NAME && node.__gjjSvgPanel) renderGrid(node);
                }
            };
            // Character/scene libraries initialize asynchronously. Rebuild the
            // cells when they become available so @角色 icons do not remain as
            // the scene-only snapshot created during workflow loading.
            globalThis.addEventListener("gjj_character_library_updated", rerenderReferenceIcons);
            globalThis.addEventListener("gjj_scene_library_updated", rerenderReferenceIcons);
            globalThis.addEventListener("gjj_costume_library_updated", rerenderReferenceIcons);

            api.addEventListener("gjj_storyboard_video_grid_plan", (event) => {
                const detail = event?.detail || {};
                const nodeId = String(detail.node || "");
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (String(node?.id) !== nodeId || nodeClass !== NODE_CLASS_NAME) continue;
                    node.properties ||= {};
                    const incomingTableSignature = String(detail.table_signature || "");
                    const savedTableSignature = String(node.properties[TABLE_SIGNATURE_PROP] || "");
                    if (incomingTableSignature && incomingTableSignature !== savedTableSignature) {
                        resetGridStateForChangedTable(node, incomingTableSignature);
                    } else if (incomingTableSignature) {
                        node.properties[TABLE_SIGNATURE_PROP] = incomingTableSignature;
                    }
                    if (detail.reset_videos) {
                        clearVideoPreviewItems(node);
                        node.__gjjSvgPanel.liveVideoRunToken = String(detail.run_token || "");
                    }
                    applyStoryboardPlan(node, detail);
                    void pollLiveVideoBatch(node, true);
                    showNodeProgress(node, `已分配 ${Number(detail.total) || detail.cells?.length || 0} 个宫格，开始生成图片…`, 0.01);
                    break;
                }
            });

            // 与 GJJ_StoryboardGridGenerator 共用同一实时图片预览事件和
            // 持久化原图/缩略图 item 结构。
            api.addEventListener("gjj_storyboard_grid_preview", (event) => {
                const detail = event?.detail || {};
                const nodeId = String(detail.node || "");
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (String(node?.id) !== nodeId || nodeClass !== NODE_CLASS_NAME) continue;
                    const currentShots = node.__gjjSvgPanel?.shots;
                    const hasCurrentPlan = Array.isArray(currentShots)
                        && currentShots.length === detail.plan_cells?.length
                        && currentShots.some((shot) => Number(shot?.duration) > 0);
                    if (Array.isArray(detail.plan_cells) && detail.plan_cells.length && !hasCurrentPlan) {
                        applyStoryboardPlan(node, { cells: detail.plan_cells, total: detail.plan_cells.length });
                    }
                    ensureLiveGrid(node, detail);
                    updateCell(node, {
                        ...detail,
                        cell_id: Math.max(0, Number(detail.index || 1) - 1),
                        phase: "keyframe",
                        status: "done",
                        item: detail.image || {},
                    });
                    break;
                }
            });

            api.addEventListener("gjj_storyboard_video_grid_progress", (event) => {
                const detail = event.detail || {};
                for (const node of app.graph?._nodes || []) {
                    if (String(node.id) === String(detail.node)) {
                        void pollLiveVideoBatch(node, detail.completed_cell_id != null);
                        // Completed-cell records also travel on the progress
                        // channel, which remains active throughout a long
                        // batch.  This keeps each play button live even if the
                        // dedicated cell event was missed by the browser.
                        const flatCompleted = detail.completed_cell_id != null
                            ? {
                                cell_id: detail.completed_cell_id,
                                index: detail.completed_index,
                                duration: detail.completed_duration,
                                video_url: detail.completed_video_url || "",
                                item: detail.completed_video_filename ? {
                                    filename: detail.completed_video_filename,
                                    subfolder: detail.completed_video_subfolder || "",
                                    type: detail.completed_video_type || "output",
                                } : {},
                            }
                            : null;
                        const completedRecord = flatCompleted
                            || (detail.video_record && typeof detail.video_record === "object" ? detail.video_record : null);
                        if (completedRecord) {
                            updateCell(node, {
                                node: String(node.id),
                                ...completedRecord,
                                phase: "video",
                                status: "done",
                            });
                        }
                        const progress = Math.max(0, Math.min(1, Number(detail.progress) || 0));
                        showNodeProgress(node, detail.message || "正在处理…", progress);
                        for (const cell of node.__gjjSvgPanel?.grid?.querySelectorAll(".gjj-svg-cell.generating") || []) {
                            const label = cell.querySelector(".gjj-svg-cell-progress-label");
                            const fill = cell.querySelector(".gjj-svg-cell-progress-fill");
                            if (label && detail.message) label.textContent = String(detail.message);
                            if (fill && progress > 0) {
                                fill.classList.remove("indeterminate");
                                fill.style.width = `${Math.max(2, progress * 100)}%`;
                                fill.style.transform = "none";
                            }
                        }
                        break;
                    }
                }
            });

            // Detailed statuses emitted by the delegated
            // GJJ_StoryboardGridGenerator/LazyImageStudio pipeline.
            api.addEventListener("gjj_node_progress", (event) => {
                const detail = event?.detail || {};
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (nodeClass !== NODE_CLASS_NAME || String(node.id) !== String(detail.node)) continue;
                    void pollLiveVideoBatch(node);
                    showNodeProgress(node, detail.text || detail.message || "正在处理图片…", detail.progress);
                    break;
                }
            });

            // ComfyUI sampler emits the real current/max iteration pair. Keep
            // this separate from coarse pipeline percentages so the user sees
            // the exact sampling step and how many iterations remain.
            api.addEventListener("progress", (event) => {
                const detail = event?.detail || {};
                const current = Math.max(0, Math.round(Number(detail.value) || 0));
                const total = Math.max(0, Math.round(Number(detail.max) || 0));
                if (!total || current > total) return;
                const nodeId = String(detail.node || detail.node_id || "");
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (nodeClass !== NODE_CLASS_NAME) continue;
                    const state = node.__gjjSvgPanel;
                    if (!state?.progressPanel || state.progressPanel.style.display === "none") continue;
                    if (nodeId && String(node.id) !== nodeId) continue;
                    const remaining = Math.max(0, total - current);
                    const base = String(state.lastProgressMessage || "正在采样…");
                    const queueMatch = base.match(/队列\s*(\d+)\s*\/\s*(\d+)/u);
                    const queueIndex = Math.max(1, Number(queueMatch?.[1]) || 1);
                    const queueTotal = Math.max(queueIndex, Number(queueMatch?.[2]) || 1);
                    const subMatch = base.match(/子分镜\s*(\d+)\s*\/\s*(\d+)/u);
                    const subIndex = Math.max(1, Number(subMatch?.[1]) || 1);
                    const subTotal = Math.max(subIndex, Number(subMatch?.[2]) || 1);
                    const subProgress = ((subIndex - 1) + current / total) / subTotal;
                    const progress = Math.min(1, Math.max(0, ((queueIndex - 1) + subProgress) / queueTotal));
                    const stepText = `${base} · 步骤 ${current}/${total} · 剩余 ${remaining} 步`;
                    showNodeProgress(node, stepText, progress);
                    for (const cell of state.grid?.querySelectorAll(".gjj-svg-cell.generating") || []) {
                        const label = cell.querySelector(".gjj-svg-cell-progress-label");
                        const fill = cell.querySelector(".gjj-svg-cell-progress-fill");
                        if (label) label.textContent = `采样 ${current}/${total} · 剩余 ${remaining} 步`;
                        if (fill) {
                            fill.classList.remove("indeterminate");
                            fill.style.width = `${Math.max(2, progress * 100)}%`;
                            fill.style.transform = "none";
                        }
                    }
                    if (nodeId) break;
                }
            });

            // Final-output fallback: websocket cell events can be missed while
            // the browser is busy painting previews. Reconcile every completed
            // video from the node's standard execution result.
            api.addEventListener("executed", (event) => {
                const detail = event?.detail || {};
                const nodeId = String(detail.node || detail.node_id || "");
                const output = detail.output && typeof detail.output === "object" ? detail.output : {};
                const records = normalizedVideoRecords(output.storyboard_videos);
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (nodeClass !== NODE_CLASS_NAME || String(node.id) !== nodeId) continue;
                    if (records.length) applyVideoRecords(node, records, records.length);
                    else applyStandardVideoItems(node, [output.videos, output.gifs, output.preview_video, output.preview_media]);
                    break;
                }
            });

            api.addEventListener("gjj_storyboard_video_grid_videos_done", (event) => {
                const detail = event?.detail || {};
                const nodeId = String(detail.node || "");
                for (const node of app.graph?._nodes || []) {
                    const nodeClass = String(node?.comfyClass || node?.type || "");
                    if (nodeClass !== NODE_CLASS_NAME || String(node.id) !== nodeId) continue;
                    applyVideoRecords(node, detail.records, detail.total);
                    break;
                }
            });

            api.addEventListener("gjj_storyboard_video_grid_cell", (event) => {
                const detail = event.detail || {};
                const nodeId = String(detail.node || "");
                // 更稳健的节点查找：遍历所有层级的节点
                const nodes = [];
                if (app.graph?._nodes) nodes.push(...app.graph._nodes);
                // 包括分组内的节点
                if (app.canvas?.selected_group?.nodes) nodes.push(...app.canvas.selected_group.nodes);
                for (const node of nodes) {
                    if (String(node.id) === nodeId) {
                        updateCell(node, detail);
                        return;
                    }
                }
                // 如果没找到，延迟一帧重试（节点可能还在初始化中）
                console.warn("[GJJ StoryboardVideoGrid] 找不到节点", { nodeId, detail });
            });
        },
    });
})();

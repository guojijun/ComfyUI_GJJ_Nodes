import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_NodeLocator";
    const EVENT_NAME = "gjj_node_locator_results";

    function getNodeById(nodeId) {
        const id = parseInt(nodeId, 10);
        if (isNaN(id)) return null;
        return app.graph?.getNodeById?.(id) || null;
    }

    function focusAndSelectNode(node) {
        if (!node) return;

        const canvas = app.canvas;
        if (!canvas) return;

        if (typeof canvas.deselectAllNodes === "function") {
            canvas.deselectAllNodes();
        } else if (typeof canvas.deselectAll === "function") {
            canvas.deselectAll();
        }

        canvas.selected_nodes = {};
        node.selected = true;

        if (typeof canvas.setSelectedNodes === "function") {
            const selected = {};
            selected[node.id] = node;
            canvas.setSelectedNodes(selected);
        }

        if (typeof canvas.centerOnNode === "function") {
            canvas.centerOnNode(node);
        } else if (typeof canvas.focusOnNode === "function") {
            canvas.focusOnNode(node);
        } else if (typeof canvas.scrollToNode === "function") {
            canvas.scrollToNode(node);
        }

        try {
            app.graph.setDirtyCanvas(true, true);
        } catch {}

        const nodeId = node.id;
        setTimeout(() => {
            const nodeEl = document.querySelector(`.litegraph .node[data-id="${nodeId}"], .litegraph .node[id="${nodeId}"]`);
            if (nodeEl) {
                nodeEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
            }
        }, 100);
    }

    function searchNodes(keyword, workflowNodes) {
        if (!keyword || !workflowNodes) return [];

        const kw = keyword.toLowerCase().trim();
        const results = [];

        for (const node of workflowNodes) {
            if (!node || typeof node !== "object") continue;

            const nodeId = String(node.id || "");
            const nodeType = String(node.type || "").toLowerCase();
            const nodeTitle = String(node.title || node.name || "").toLowerCase();

            let score = 0;
            if (kw === nodeType) score = 100;
            else if (nodeType.startsWith(kw)) score = 80;
            else if (nodeType.includes(kw)) score = 60;

            if (kw === nodeTitle) score = Math.max(score, 50);
            else if (nodeTitle.startsWith(kw)) score = Math.max(score, 40);
            else if (nodeTitle.includes(kw)) score = Math.max(score, 20);

            if (nodeId === kw) score = Math.max(score, 30);
            else if (nodeId.includes(kw)) score = Math.max(score, 10);

            if (score > 0) {
                results.push({
                    id: nodeId,
                    type: node.type || "",
                    title: node.title || node.name || "",
                    score,
                });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 20);
    }

    function createResultsUI(node, results) {
        const container = node.ui?.container || node.container;
        if (!container) return;

        let existingResults = container.querySelector(".gjj-node-locator-results");
        if (existingResults) {
            existingResults.remove();
        }

        if (!results || results.length === 0) {
            const empty = document.createElement("div");
            empty.className = "gjj-node-locator-results";
            empty.style.cssText = "padding: 12px; text-align: center; color: #888; font-size: 12px;";
            empty.textContent = "未找到匹配的节点";
            container.appendChild(empty);
            return;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "gjj-node-locator-results";
        wrapper.style.cssText = "max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 4px; margin-top: 6px;";

        const header = document.createElement("div");
        header.style.cssText = "padding: 6px 10px; font-size: 11px; color: #888; border-bottom: 1px solid rgba(255,255,255,0.1);";
        header.textContent = `找到 ${results.length} 个匹配节点`;
        wrapper.appendChild(header);

        results.forEach((item) => {
            const el = document.createElement("div");
            el.style.cssText = "padding: 8px 10px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px; color: #ccc; display: flex; align-items: center; gap: 8px; transition: background 0.15s;";

            const icon = document.createElement("span");
            icon.textContent = "📍";
            icon.style.cssText = "flex-shrink: 0;";

            const info = document.createElement("div");
            info.style.cssText = "flex: 1; min-width: 0;";

            const title = document.createElement("div");
            title.style.cssText = "font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            title.textContent = item.title || item.type || `节点 ${item.id}`;

            const subtitle = document.createElement("div");
            subtitle.style.cssText = "font-size: 10px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            subtitle.textContent = `${item.type} | ID: ${item.id}`;

            info.appendChild(title);
            info.appendChild(subtitle);
            el.appendChild(icon);
            el.appendChild(info);

            el.addEventListener("mouseenter", () => el.style.background = "rgba(255,255,255,0.1)");
            el.addEventListener("mouseleave", () => el.style.background = "");

            el.addEventListener("click", () => {
                const targetNode = getNodeById(item.id);
                if (targetNode) {
                    focusAndSelectNode(targetNode);
                } else {
                    console.warn(`[GJJ_NodeLocator] 节点 ${item.id} 不存在`);
                }
            });

            wrapper.appendChild(el);
        });

        container.appendChild(wrapper);
    }

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name !== NODE_CLASS_NAME) return;
        },

        async setup() {
            api.addEventListener(EVENT_NAME, (event) => {
                const detail = event.detail || {};
                const node = getNodeById(detail.node);
                if (!node) return;
            });
        },

        nodeCreated(node) {
            if (node.type !== NODE_CLASS_NAME) return;

            const keywordWidget = node.widgets?.find?.(w => w.name === "keyword");
            if (!keywordWidget) return;

            let resultsShown = null;

            const performSearch = () => {
                const keyword = keywordWidget.value || "";
                if (!keyword.trim()) {
                    resultsShown = null;
                    const container = node.ui?.container || node.container;
                    if (container) {
                        const existing = container.querySelector(".gjj-node-locator-results");
                        if (existing) existing.remove();
                    }
                    return;
                }

                const workflow = app.History?.workflow || app.workflow || {};
                const workflowNodes = workflow?.nodes || [];
                const results = searchNodes(keyword, workflowNodes);
                resultsShown = results;
                createResultsUI(node, results);
            };

            if (keywordWidget.callback) {
                const originalCallback = keywordWidget.callback;
                keywordWidget.callback = (value) => {
                    originalCallback(value);
                    setTimeout(performSearch, 50);
                };
            } else {
                keywordWidget.callback = () => setTimeout(performSearch, 50);
            }

            if (keywordWidget.element) {
                keywordWidget.element.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        const keyword = keywordWidget.value || "";
                        if (keyword.trim() && resultsShown && resultsShown.length > 0) {
                            const firstResult = resultsShown[0];
                            const targetNode = getNodeById(firstResult.id);
                            if (targetNode) {
                                focusAndSelectNode(targetNode);
                            }
                        }
                    }
                });
            }

            node.onExecute?.(() => {
                if (keywordWidget?.value?.trim()) {
                    setTimeout(performSearch, 100);
                }
            });
        },
    });
})();

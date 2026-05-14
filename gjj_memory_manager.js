
function makeActionButton(node, label, action, icon, className, statusEl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `gjj-memory-btn gjj-memory-action-btn ${className}`;
    // btn.textContent = `${icon}\n${label}`;
    // 新增:
    btn.innerHTML = `<span>${icon}</span><span>${label}</span>`;
    btn.title = `只执行本节点后端动作：${label}。不会提交整个工作流。`;

    btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        try {
            if (statusEl) statusEl.textContent = "正在处理...";
            const props = ensureProps(node);
            props[ACTION_PROP] = ACTION_REFRESH; // 避免手动动作残留到后续正常队列。
            markDirty(node);

            const detail = await requestAction(node, action);
            updateStatsForNode(node, detail);
        } catch (error) {
            console.warn("[GJJ_MemoryManager] action failed:", error);
            if (statusEl) statusEl.textContent = `执行失败：${error.message || error}`;
        }
    });

    return btn;
}


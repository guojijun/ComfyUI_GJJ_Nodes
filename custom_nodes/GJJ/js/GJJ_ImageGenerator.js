
// 添加执行按钮和图片预览逻辑
app.registerExtension({
    name: 'GJJ_ImageGenerator',
    onNodeCreated(node) {
        // 隐藏【批量图片来源】字段
        const sourceInput = node.widgets.find(w => w.name === 'source');
        if (sourceInput) {
            sourceInput.element.style.display = 'none';
        }

        // 动态扩展 Lora 插槽
        const loraSlots = ['lora_1_name', 'lora_1_strength', 'lora_2_name', 'lora_2_strength'];
        let loraIndex = 2;
        node.addDOMWidget({
            name: '__gjj_lora_controls',
            label: 'LoRA 串联配置',
            widget: null,
            type: 'custom',
            value: '',
            onChange: () => {},
            element: document.createElement('div'),
            container: node.container,
            refresh: () => {}
        });

        // 添加执行按钮
        const execButton = document.createElement('button');
        execButton.textContent = '执行';
        execButton.onclick = () => {
            queueOnlyCurrentNode(node);
        };
        node.container.appendChild(execButton);

        // 添加图片预览容器
        const previewContainer = document.createElement('div');
        previewContainer.id = 'gjj-image-preview';
        previewContainer.style.cssText = `
            margin-top: 10px;
            border: 1px solid #ccc;
            overflow: hidden;
            position: relative;
            cursor: pointer;
            width: 100%;
            height: 200px;
            background-color: #f0f0f0;
        `;
        node.container.appendChild(previewContainer);

        // 图片点击放大逻辑
        let isZoomed = false;
        let zoomLevel = 1;
        previewContainer.addEventListener('click', () => {
            isZoomed = !isZoomed;
            if (isZoomed) {
                previewContainer.style.transform = `scale(${zoomLevel})`;
                previewContainer.style.transformOrigin = 'center center';
                previewContainer.style.overflow = 'auto';
            } else {
                previewContainer.style.transform = 'scale(1)';
                previewContainer.style.overflow = 'hidden';
            }
        });

        // 鼠标滚轮缩放
        previewContainer.addEventListener('wheel', (e) => {
            if (!isZoomed) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            zoomLevel *= delta;
            previewContainer.style.transform = `scale(${zoomLevel})`;
        });
    }
});
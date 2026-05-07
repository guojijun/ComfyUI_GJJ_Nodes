class GJJBatchWatermarkRemoverNode {
    // ... existing methods ...

    setupNode() {
        // 确保 this 对象已正确初始化
        if (!this) {
            console.error("this is undefined in setupNode");
            return;
        }

        // 添加清除按钮
        this.addClearButton();
    }

    addClearButton() {
        // 检查 this 是否为 undefined
        if (!this) {
            console.error("this is undefined in addClearButton");
            return;
        }

        // 使用 node.addDOMWidget 创建按钮
        const button = document.createElement('button');
        button.innerHTML = '清除';
        button.style.cssText = 'position: absolute; top: 5px; right: 5px; width: 30px; height: 30px; background-color: #ff0000; color: white; border: none; border-radius: 50%; cursor: pointer;';
        button.onclick = () => {
            // 清除逻辑
            this.clear();
        };

        // 使用 addDOMWidget 创建按钮
        this.addDOMWidget({
            name: '__gjj_clear_button',
            label: '清除',
            widget: button,
            type: 'button'
        });
    }

    // ... existing methods ...
}

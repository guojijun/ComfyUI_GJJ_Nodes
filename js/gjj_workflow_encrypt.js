/**
 * GJJ Workflow Encrypt - 工作流加密前端 UI
 *
 * 功能：
 * - 在 ComfyUI 菜单中添加"保存(加密)"和"加载(解密)"按钮
 * - 加密工作流并下载加密文件
 * - 解密工作流并加载到画布
 *
 * 基于 jtydhr88/ComfyUI-Workflow-Encrypt 改造
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { $el } from "../../scripts/ui.js";

// ============================================================================
// API 接口定义
// ============================================================================

// 保存加密工作流
api.addEventListener("workflow_encrypt:save", async ({ detail }) => {
    try {
        const response = await api.fetchApi("/gjj/workflow_encrypt/save_encrypt_method", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflow: detail.workflow
            })
        });

        const data = await response.json();

        if (data.error) {
            // 依赖缺失错误
            alert(`❌ 错误\n\n${data.error}\n\n请查看控制台获取安装命令。`);
            return;
        }

        const key = data['key'];
        const encryptedData = data['encrypted_data'];

        // 显示密钥
        alert(
            `✅ 加密成功！\n\n` +
            `⚠️ 重要提示：\n` +
            `1. 请妥善保存以下密钥，它只会显示这一次！\n` +
            `2. 没有密钥将无法解密工作流\n\n` +
            `🔑 密钥：\n${key}\n\n` +
            `📦 加密数据长度：${encryptedData.length} 字符\n\n` +
            `💡 使用提示：\n` +
            `- 将密钥和加密文件一起分享给他人\n` +
            `- 接收方需要安装 GJJ 扩展并输入密钥解密`
        );

        // 下载加密文件
        const blob = new Blob([encryptedData], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'workflow_encrypted.txt';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error("[GJJ Workflow Encrypt] 加密失败:", error);
        alert(`❌ 加密失败：\n${error.message}`);
    }
});

// 加载解密工作流
api.addEventListener("workflow_encrypt:load", async () => {
    try {
        // 提示输入密钥
        const decryptedKey = prompt("请输入解密密钥：");

        if (decryptedKey === null) {
            console.log("[GJJ Workflow Encrypt] 用户取消操作");
            return;
        }

        if (!decryptedKey.trim()) {
            alert("❌ 密钥不能为空！");
            return;
        }

        // 选择加密文件
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.txt,.json';

        fileInput.onchange = async (e) => {
            const files = e.target.files;
            if (files.length === 0) return;

            const file = files[0];
            const reader = new FileReader();

            reader.onload = async (loadEvent) => {
                try {
                    const fileContent = loadEvent.target.result;

                    const response = await api.fetchApi('/gjj/workflow_encrypt/load_decrypted_method', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            decryptedKey: decryptedKey,
                            fileContent: fileContent
                        })
                    });

                    const data = await response.json();

                    if (data.status === 'Decrypted failed') {
                        alert(
                            `❌ 解密失败！\n\n` +
                            `请检查：\n` +
                            `1. 密钥是否正确\n` +
                            `2. 加密文件是否完整\n` +
                            `3. 文件是否被修改`
                        );
                        return;
                    }

                    if (data.error) {
                        alert(`❌ 错误\n\n${data.error}\n\n请查看控制台获取安装命令。`);
                        return;
                    }

                    // 加载工作流
                    await app.loadGraphData(data);
                    console.log("[GJJ Workflow Encrypt] 工作流加载成功");

                } catch (error) {
                    console.error("[GJJ Workflow Encrypt] 解密失败:", error);
                    alert(`❌ 解密失败：\n${error.message}`);
                }
            };

            reader.readAsText(file);
        };

        fileInput.click();

    } catch (error) {
        console.error("[GJJ Workflow Encrypt] 加载失败:", error);
        alert(`❌ 加载失败：\n${error.message}`);
    }
});

// ============================================================================
// UI 扩展
// ============================================================================

app.registerExtension({
    name: "GJJ.WorkflowEncryptMenu",

    async setup() {
        // 保存原始的 clear 方法
        const orig_clear = app.graph.clear;
        app.graph.clear = function () {
            orig_clear.call(app.graph);
        };

        // 添加分隔线
        const menu = document.querySelector(".comfy-menu");
        if (!menu) {
            console.warn("[GJJ Workflow Encrypt] 未找到 comfy-menu 元素");
            return;
        }

        const separator = document.createElement("hr");
        separator.style.margin = "20px 0";
        separator.style.width = "100%";
        menu.append(separator);

        // 保存(加密)按钮
        const saveButton = document.createElement("button");
        saveButton.textContent = "💾 保存(加密)";
        saveButton.title = "加密工作流并下载";
        saveButton.style.marginBottom = "10px";

        saveButton.onclick = () => {
            app.graphToPrompt().then((prompt) => {
                const workflow = prompt['workflow'];
                api.dispatchEvent(new CustomEvent("workflow_encrypt:save", { detail: { workflow } }));
            }).catch((error) => {
                console.error("[GJJ Workflow Encrypt] 获取工作流失败:", error);
                alert(`❌ 获取工作流失败：\n${error.message}`);
            });
        };

        menu.append(saveButton);

        // 加载(解密)按钮
        const loadButton = document.createElement("button");
        loadButton.textContent = "📂 加载(解密)";
        loadButton.title = "解密并加载工作流";
        loadButton.style.marginBottom = "10px";

        loadButton.onclick = () => {
            api.dispatchEvent(new CustomEvent("workflow_encrypt:load"));
        };

        menu.append(loadButton);

        console.log("[GJJ Workflow Encrypt] UI 扩展已加载");
    }
});

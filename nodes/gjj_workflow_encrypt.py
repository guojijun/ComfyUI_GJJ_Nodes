"""
GJJ Workflow Encrypt - 工作流加密节点
基于 comfyui-workflow-encrypt 复刻，使用运行时依赖懒加载

功能：
- 加密工作流并分享给他人
- 使用密钥解密工作流
- 依赖 cryptography 库，支持运行时自动安装

作者: 基于 jtydhr88/ComfyUI-Workflow-Encrypt 改造
许可证: AGPL-3.0
"""

import os
import sys

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ============================================================================
# 依赖管理 - 运行时懒加载
# ============================================================================

_cached_fernet = None

def _get_fernet():
    """懒加载 Fernet 加密模块"""
    global _cached_fernet

    if _cached_fernet is not None:
        return _cached_fernet

    try:
        from cryptography.fernet import Fernet
        _cached_fernet = Fernet
        return Fernet
    except ImportError as exc:
        from .common_utils.dependency_checker import (
            print_runtime_dependency_error,
            get_pip_install_command_text
        )

        # 打印美观的控制台错误提示
        print_runtime_dependency_error(
            node_name="🔐 GJJ 工作流加密",
            dependency_name="cryptography",
            install_command=get_pip_install_command_text("cryptography"),
            description="该节点需要 cryptography Python 包进行工作流加密/解密",
            extra_info=f"原始导入错误：{exc}"
        )

        _cached_fernet = None
        return None

# ============================================================================
# 节点类
# ============================================================================

class GJJ_WorkflowEncrypt:
    """工作流加密节点"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "action": (["encrypt", "decrypt"], {
                    "default": "encrypt",
                    "tooltip": "选择加密或解密操作"
                }),
            },
            "optional": {
                "workflow_json": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "要加密的工作流 JSON 数据"
                }),
                "encrypted_data": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "要解密的数据"
                }),
                "encryption_key": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "tooltip": "加密密钥（加密时自动生成，解密时需提供）"
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("result", "info")
    FUNCTION = "execute"
    CATEGORY = "GJJ/工具"
    DESCRIPTION = "工作流加密/解密工具\n\n加密：将工作流 JSON 加密为安全字符串\n解密：使用密钥解密工作流数据\n\n⚠️ 需要 cryptography 库支持"

    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, action, workflow_json="", encrypted_data="", encryption_key=""):
        """执行加密或解密操作"""

        # 懒加载依赖
        Fernet = _get_fernet()

        if Fernet is None:
            return ("", "❌ 缺少依赖: cryptography\n\n请查看控制台获取安装命令。\n安装后重启 ComfyUI 即可使用。")

        try:
            if action == "encrypt":
                if not workflow_json:
                    return ("", " 错误: 请提供要加密的工作流 JSON 数据")

                # 生成密钥
                key = Fernet.generate_key()
                key_str = key.decode('utf-8')

                # 加密数据
                cipher_suite = Fernet(key)
                encrypted = cipher_suite.encrypt(workflow_json.encode('utf-8'))
                encrypted_str = encrypted.decode('utf-8')

                info = (
                    f"✅ 加密成功！\n\n"
                    f"️ 重要提示：\n"
                    f"1. 请妥善保存以下密钥，它只会显示这一次！\n"
                    f"2. 没有密钥将无法解密工作流\n\n"
                    f"🔑 密钥：\n{key_str}\n\n"
                    f"📦 加密数据长度：{len(encrypted_str)} 字符\n\n"
                    f"💡 使用提示：\n"
                    f"- 将密钥和加密数据一起分享给他人\n"
                    f"- 接收方需要使用相同的密钥解密"
                )

                return (encrypted_str, info)

            elif action == "decrypt":
                if not encrypted_data:
                    return ("", "❌ 错误: 请提供要解密的数据")

                if not encryption_key:
                    return ("", "❌ 错误: 请提供解密密钥")

                try:
                    # 解密数据
                    key_bytes = encryption_key.encode('utf-8')
                    cipher_suite = Fernet(key_bytes)
                    decrypted = cipher_suite.decrypt(encrypted_data.encode('utf-8'))
                    decrypted_str = decrypted.decode('utf-8')

                    info = (
                        f"✅ 解密成功！\n\n"
                        f"📊 数据长度：{len(decrypted_str)} 字符\n\n"
                        f"💡 使用提示：\n"
                        f"- 可以将解密后的 JSON 数据导入到工作流中\n"
                        f"- 建议在文本编辑器中查看和编辑"
                    )

                    return (decrypted_str, info)

                except Exception as e:
                    return ("", f"❌ 解密失败：\n{str(e)}\n\n请检查：\n1. 密钥是否正确\n2. 加密数据是否完整")

            else:
                return ("", f"❌ 未知操作: {action}")

        except Exception as e:
            return ("", f"❌ 执行失败：\n{str(e)}")


# ============================================================================
# API 路由注册
# ============================================================================

try:
    import json
    from aiohttp import web
    from server import PromptServer

    if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
        server = PromptServer.instance

        if not getattr(server, "_gjj_workflow_encrypt_routes_registered", False):

            @server.routes.post("/gjj/workflow_encrypt/save_encrypt_method")
            async def save_encrypt_method(request):
                """加密工作流"""
                try:
                    json_data = await request.json()
                    workflow = json_data.get('workflow')

                    if not workflow:
                        return web.json_response(
                            {"error": "❌ 工作流数据为空"},
                            status=400
                        )

                    workflow_str = json.dumps(workflow)

                    # 懒加载依赖
                    Fernet = _get_fernet()
                    if Fernet is None:
                        return web.json_response(
                            {"error": "❌ 缺少依赖: cryptography\n请查看控制台获取安装命令。"},
                            status=500
                        )

                    # 生成密钥并加密
                    key = Fernet.generate_key()
                    key_output = key.decode('utf-8')

                    cipher_suite = Fernet(key)
                    encrypted_data = cipher_suite.encrypt(workflow_str.encode('utf-8'))

                    # 打印密钥到控制台
                    print("\n" + "=" * 80)
                    print("🔐 [GJJ 工作流加密] 密钥生成成功！")
                    print("️  重要提示：该密钥只会显示这一次，请妥善保存！")
                    print("=" * 80)
                    print(key_output)
                    print("=" * 80 + "\n")

                    return web.json_response({
                        'key': key_output,
                        'encrypted_data': encrypted_data.decode('utf-8')
                    })

                except Exception as e:
                    print(f"[GJJ 工作流加密] 加密失败: {e}")
                    return web.json_response(
                        {"error": f"❌ 加密失败：{str(e)}"},
                        status=500
                    )

            @server.routes.post("/gjj/workflow_encrypt/load_decrypted_method")
            async def load_decrypted_method(request):
                """解密工作流"""
                try:
                    json_data = await request.json()

                    # 懒加载依赖
                    Fernet = _get_fernet()
                    if Fernet is None:
                        return web.json_response(
                            {"error": "❌ 缺少依赖: cryptography\n请查看控制台获取安装命令。", "status": "Decrypted failed"},
                            status=500
                        )

                    key_bytes = json_data['decryptedKey'].encode()
                    encrypted_content = json_data['fileContent'].encode()

                    cipher_suite = Fernet(key_bytes)
                    decrypted_data = cipher_suite.decrypt(encrypted_content)
                    decrypted_json = json.loads(decrypted_data.decode('utf-8'))

                    print("[GJJ 工作流加密] 解密成功")

                    return web.json_response(decrypted_json)

                except Exception as e:
                    print(f"[GJJ 工作流加密] 解密失败: {e}")
                    return web.json_response({"status": "Decrypted failed"})

            setattr(server, "_gjj_workflow_encrypt_routes_registered", True)

except Exception as exc:
    print(f"[GJJ 工作流加密] API 路由注册失败: {exc}")


# ============================================================================
# 注册节点
# ============================================================================

NODE_CLASS_MAPPINGS["GJJ_WorkflowEncrypt"] = GJJ_WorkflowEncrypt
NODE_DISPLAY_NAME_MAPPINGS["GJJ_WorkflowEncrypt"] = "🔐 GJJ 工作流加密"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']

from __future__ import annotations

import gc
import hashlib
import os
import sys
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import ProgressBar


NODE_NAME = "GJJ_WanVideoTextEncodeCached"
NODE_DISPLAY_NAME = "📝 WanVideo 文本编码（缓存版）"

# ============================================================================
# 启动时依赖检查
# ============================================================================
_DEPENDENCY_CHECKER = None
_DEPENDENCIES_AVAILABLE = False
_MODELS_AVAILABLE = True
_MISSING_DEPENDENCIES = []
_MISSING_MODELS = []
_DESCRIPTION = "编码文本提示词为文本嵌入，支持磁盘缓存加速。加载 T5 编码器后自动卸载，不占用显存。"
_GJJ_HELP = {
    "title": "WanVideo 文本编码（缓存版）",
    "description": "把正向和负向提示词编码为 WanVideo 可读取的文本嵌入，支持磁盘缓存避免重复编码。",
    "usage": [
        "模型选择：从 models/text_encoders/ 目录及其子目录中自动扫描可用模型。",
        "精度：bf16 推荐用于现代 GPU，fp32 精度最高但显存占用大。",
        "量化：disabled 为不量化，fp8_e4m3fn 可减少显存使用。",
        "使用磁盘缓存：开启后将嵌入结果缓存到磁盘，下次使用相同提示词时直接加载。",
    ],
    "dependencies": [
        "ftfy：WanVideo 文本编码需要 ftfy 修复文本编码问题。",
        "transformers：加载 T5 文本编码器模型。",
    ],
    "notes": [
        "本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。",
        "缺失依赖时，节点面板会显示复制安装命令按钮，点击后可在 PowerShell 中直接执行安装。",
        "安装完成后请重启 ComfyUI 服务器。",
    ],
}


def _load_dependency_checker():
    """懒加载 GJJ 公共依赖检查工具。"""
    global _DEPENDENCY_CHECKER
    if _DEPENDENCY_CHECKER is not None:
        return _DEPENDENCY_CHECKER
    try:
        try:
            from .common_utils import dependency_checker as checker
        except Exception:
            from common_utils.dependency_checker import (
                build_dependency_model_report,
                print_dependency_model_report,
                get_pip_install_command_text,
                send_dependency_model_notice,
                _generate_warning_message,
            )
            _DEPENDENCY_CHECKER = {
                "build_dependency_model_report": build_dependency_model_report,
                "print_dependency_model_report": print_dependency_model_report,
                "get_pip_install_command_text": get_pip_install_command_text,
                "send_dependency_model_notice": send_dependency_model_notice,
                "_generate_warning_message": _generate_warning_message,
            }
            return _DEPENDENCY_CHECKER
    except Exception:
        pass
    return None


def _check_startup_dependencies():
    """启动时检查依赖，只跳过当前节点，不影响其他节点。"""
    global _DEPENDENCIES_AVAILABLE, _MISSING_DEPENDENCIES, _DESCRIPTION

    checker = _load_dependency_checker()
    required_modules = [
        ("ftfy", "ftfy", "WanVideo 文本编码需要 ftfy 修复文本编码问题。"),
        ("transformers", "transformers", "加载 T5 文本编码器模型。"),
    ]

    missing = []
    for module_name, package_name, description in required_modules:
        try:
            __import__(module_name)
        except ImportError:
            missing.append({
                "module_name": module_name,
                "package_name": package_name,
                "display_name": module_name,
                "description": description,
            })

    if missing:
        _DEPENDENCIES_AVAILABLE = False
        _MISSING_DEPENDENCIES = missing

        if checker is not None:
            report = checker["build_dependency_model_report"](
                node_name=NODE_DISPLAY_NAME,
                missing_dependencies=missing,
                install_packages=[m["package_name"] for m in missing],
            )
            report["node_name"] = NODE_DISPLAY_NAME
            _DESCRIPTION = report.get("description_message") or report.get("warning_message")
            _GJJ_HELP["description"] = report.get("help_message") or _GJJ_HELP["description"]
            _GJJ_HELP["install_cmd"] = report.get("install_cmd", "")
            _GJJ_HELP["warning_message"] = report.get("warning_message", "")

            try:
                checker["print_dependency_model_report"](
                    report,
                    title="GJJ WanVideo 文本编码 启动时依赖缺失！",
                )
            except Exception:
                pass
        else:
            install_cmd = _build_fallback_install_cmd([m["package_name"] for m in missing])
            _DESCRIPTION = (
                f"⚠️缺失运行依赖，点击❓按钮了解详情。\n\n"
                f"📦 必需依赖：{', '.join(m['package_name'] for m in missing)}\n\n"
                f"🔧 快速安装命令：\n{install_cmd}\n\n"
                f"提示：安装后请重启 ComfyUI 服务器。"
            )

            red = "\033[91m"
            yellow = "\033[93m"
            cyan = "\033[96m"
            green = "\033[92m"
            reset = "\033[0m"
            line = "=" * 90
            print(f"\n{red}{line}{reset}")
            print(f"{red}  GJJ WanVideo 文本编码 启动时依赖缺失！{reset}")
            print(f"{red}{line}{reset}")
            print(f"{yellow}[GJJ] {reset}节点: {cyan}{NODE_DISPLAY_NAME}{reset}")
            for m in missing:
                print(f"{yellow}[GJJ] {reset}缺失依赖: {red}{m['module_name']}{reset}")
                if m.get("description"):
                    print(f"{yellow}[GJJ] {reset}{m['description']}")
            print(f"\n{yellow}[GJJ] {reset}快速安装命令:")
            print(f"{green}{install_cmd}{reset}")
            print(f"\n{yellow}[GJJ] {reset}提示: 安装后请重启 ComfyUI 服务器")
            print(f"{red}{line}{reset}\n")
    else:
        _DEPENDENCIES_AVAILABLE = True


def _build_fallback_install_cmd(packages):
    """兜底安装命令生成。"""
    import os
    python_path = sys.executable
    site_packages = os.path.join(os.path.dirname(python_path), "Lib", "site-packages")
    pkgs = " ".join(packages)
    return f'& "{python_path}" -m pip install {pkgs} -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "{site_packages}"'


def _handle_runtime_dependency_error(error, unique_id=None):
    """运行时依赖缺失处理：控制台彩色输出 + 前端事件推送。"""
    checker = _load_dependency_checker()

    missing_modules = []
    error_str = str(error)
    if "ftfy" in error_str.lower():
        missing_modules.append({
            "module_name": "ftfy",
            "package_name": "ftfy",
            "display_name": "ftfy",
            "description": "WanVideo 文本编码需要 ftfy 修复文本编码问题。",
        })
    if "transformers" in error_str.lower():
        missing_modules.append({
            "module_name": "transformers",
            "package_name": "transformers",
            "display_name": "transformers",
            "description": "加载 T5 文本编码器模型。",
        })

    if not missing_modules:
        missing_modules.append({
            "module_name": "ftfy",
            "package_name": "ftfy",
            "display_name": "ftfy",
            "description": "WanVideo 运行时依赖 ftfy 库。",
        })

    packages = [m["package_name"] for m in missing_modules]

    if checker is not None:
        report = checker["build_dependency_model_report"](
            node_name=NODE_DISPLAY_NAME,
            missing_dependencies=missing_modules,
            install_packages=packages,
            original_error=error_str,
        )
        report["node_name"] = NODE_DISPLAY_NAME

        try:
            checker["print_dependency_model_report"](
                report,
                title="GJJ 节点运行时依赖缺失！",
            )
        except Exception:
            pass

        if unique_id is not None:
            try:
                checker["send_dependency_model_notice"](
                    report,
                    unique_id=unique_id,
                )
            except Exception:
                pass

        return report.get("install_cmd", "") or _build_fallback_install_cmd(packages)
    else:
        install_cmd = _build_fallback_install_cmd(packages)

        red = "\033[91m"
        yellow = "\033[93m"
        cyan = "\033[96m"
        green = "\033[92m"
        reset = "\033[0m"
        line = "=" * 90
        print(f"\n{red}{line}{reset}")
        print(f"{red}  GJJ 节点运行时依赖缺失！{reset}")
        print(f"{red}{line}{reset}")
        print(f"{yellow}[GJJ] {reset}节点: {cyan}{NODE_DISPLAY_NAME}{reset}")
        for m in missing_modules:
            print(f"{yellow}[GJJ] {reset}缺失依赖: {red}{m['module_name']}{reset}")
            if m.get("description"):
                print(f"{yellow}[GJJ] {reset}{m['description']}")
        print(f"\n{yellow}[GJJ] {reset}快速安装命令:")
        print(f"{green}{install_cmd}{reset}")
        print(f"\n{yellow}[GJJ] {reset}原始错误: {error_str}")
        print(f"\n{yellow}[GJJ] {reset}提示: 安装后请重启 ComfyUI 服务器")
        print(f"{red}{line}{reset}\n")

        if unique_id is not None:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync("gjj_dependency_model_notice", {
                    "node": str(unique_id),
                    "warning_message": f"⚠️缺失运行依赖，点击❓按钮了解详情。",
                    "panel_message": (
                        f"⚠️缺失运行依赖，点击❓按钮了解详情。\n\n"
                        f"📦 必需依赖（请安装）：\n"
                        + "\n".join(f"• {m['package_name']}（{m['description']}）" for m in missing_modules)
                        + f"\n\n🔧 快速安装命令：\n{install_cmd}\n\n"
                        f"原始错误：{error_str}\n\n"
                        f"提示：安装后请重启 ComfyUI 服务器。"
                    ),
                    "install_command": install_cmd,
                    "copy_text": install_cmd,
                    "copy_label": "📋 复制安装命令",
                })
            except Exception:
                pass

        return install_cmd


# 启动时检查依赖
_check_startup_dependencies()


def _scan_text_encoders(keyword="umt5-xxl-enc"):
    """扫描 text_encoders 目录，按关键词过滤并返回模型列表。
    
    Args:
        keyword: 过滤关键词，默认 "umt5-xxl-enc"
    
    Returns:
        (model_list, default_model) 元组
    """
    all_encoders = []
    try:
        all_encoders = list(folder_paths.get_filename_list("text_encoders"))
    except Exception:
        pass
    
    if not all_encoders:
        return ["[未找到模型]"], "[未找到模型]"
    
    keyword_lower = keyword.lower()
    matched = [
        name for name in all_encoders
        if keyword_lower in name.lower()
    ]
    
    if matched:
        return matched, matched[0]
    
    return all_encoders, all_encoders[0]


def _load_wanvideo_nodes():
    """懒加载 WanVideoWrapper 节点依赖"""
    try:
        from ..vendor.wanvideo_wrapper import nodes as wan_nodes
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 文本编码加载失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
        ) from error
    return wan_nodes


def _load_wanvideo_model_loading():
    """懒加载 WanVideoWrapper 模型加载模块"""
    try:
        from ..vendor.wanvideo_wrapper import nodes_model_loading
    except ImportError as error:
        raise RuntimeError(
            "GJJ 内置 WanVideo 模型加载模块失败。\n"
            f"错误信息: {error}\n"
            "说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
        ) from error
    return nodes_model_loading


def _get_cache_dir():
    """获取文本嵌入缓存目录"""
    cache_dir = os.path.join(os.path.dirname(__file__), "..", "cache", "wanvideo_text_embeds")
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir


def _get_cache_path(prompt):
    """根据提示内容生成缓存文件路径"""
    cache_key = prompt.strip()
    cache_hash = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
    cache_dir = _get_cache_dir()
    return os.path.join(cache_dir, f"{cache_hash}.pt")


def _get_cached_text_embeds(positive_prompt, negative_prompt):
    """从磁盘缓存加载文本嵌入"""
    context = None
    context_null = None

    pos_cache_path = _get_cache_path(positive_prompt)
    neg_cache_path = _get_cache_path(negative_prompt)

    if os.path.exists(pos_cache_path):
        try:
            print(f"[GJJ WanVideoTextEncode] 从缓存加载正向提示词嵌入: {pos_cache_path}")
            context = torch.load(pos_cache_path, weights_only=False)
        except Exception as e:
            print(f"[GJJ WanVideoTextEncode] 缓存加载失败: {e}，将重新编码")

    if os.path.exists(neg_cache_path):
        try:
            print(f"[GJJ WanVideoTextEncode] 从缓存加载负向提示词嵌入: {neg_cache_path}")
            context_null = torch.load(neg_cache_path, weights_only=False)
        except Exception as e:
            print(f"[GJJ WanVideoTextEncode] 缓存加载失败: {e}，将重新编码")

    return context, context_null


def _save_text_embeds(positive_prompt, negative_prompt, context, context_null):
    """将文本嵌入保存到磁盘缓存"""
    try:
        cache_dir = _get_cache_dir()
        os.makedirs(cache_dir, exist_ok=True)

        pos_cache_path = _get_cache_path(positive_prompt)
        neg_cache_path = _get_cache_path(negative_prompt)

        torch.save(context, pos_cache_path)
        print(f"[GJJ WanVideoTextEncode] 正向提示词嵌入已缓存: {pos_cache_path}")

        if context_null is not None:
            torch.save(context_null, neg_cache_path)
            print(f"[GJJ WanVideoTextEncode] 负向提示词嵌入已缓存: {neg_cache_path}")
    except Exception as e:
        print(f"[GJJ WanVideoTextEncode] 缓存保存失败: {e}")


class GJJ_WanVideoTextEncodeCached:
    CATEGORY = "GJJ/视频生成"
    FUNCTION = "process"
    DESCRIPTION = _DESCRIPTION
    SEARCH_ALIASES = [
        "WanVideo Text Encode",
        "Wan T5 文本编码",
        "提示词嵌入",
        "Wan2.1 文本编码器",
    ]
    RETURN_TYPES = ("WANVIDEOTEXTEMBEDS", "WANVIDEOTEXTEMBEDS", "STRING")
    RETURN_NAMES = ("文本嵌入", "负向文本嵌入", "正向提示词")
    OUTPUT_TOOLTIPS = (
        "正向和负向提示词的文本嵌入",
        "仅负向提示词的嵌入（用于 NAG）",
        "处理后的正向提示词",
    )

    GJJ_HELP = _GJJ_HELP

    @classmethod
    def INPUT_TYPES(cls):
        text_encoders, default_encoder = _scan_text_encoders("umt5-xxl-enc")
        
        return {
            "required": {
                "model_name": (
                    text_encoders,
                    {
                        "default": default_encoder,
                        "display_name": "模型选择",
                        "tooltip": "自动搜索 ComfyUI/models/text_encoders/ 及其子目录，默认优先显示包含 umt5-xxl-enc 的模型。",
                    },
                ),
                "precision": (
                    ["bf16", "fp32"],
                    {
                        "default": "bf16",
                        "display_name": "精度",
                        "tooltip": "模型计算精度，bf16 推荐用于现代 GPU。",
                    },
                ),
                "positive_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "正向提示词",
                        "tooltip": "描述想要生成的内容。",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "display_name": "负向提示词",
                        "tooltip": "描述不想要生成的内容。",
                    },
                ),
                "quantization": (
                    ["disabled", "fp8_e4m3fn"],
                    {
                        "default": "disabled",
                        "display_name": "量化",
                        "tooltip": "可选量化方法，fp8_e4m3fn 可减少显存使用。",
                    },
                ),
                "use_disk_cache": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "使用磁盘缓存",
                        "tooltip": "开启后将文本嵌入缓存到磁盘，下次使用时无需重新编码。",
                    },
                ),
                "device": (
                    ["gpu", "cpu"],
                    {
                        "default": "gpu",
                        "display_name": "计算设备",
                        "tooltip": "文本编码计算设备。",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def process(
        self,
        model_name,
        precision,
        positive_prompt,
        negative_prompt,
        quantization="disabled",
        use_disk_cache=True,
        device="gpu",
        unique_id=None,
        extra_pnginfo=None,
    ):
        print(f"[GJJ WanVideoTextEncode] ========== 开始编码文本 ==========")
        print(f"[GJJ WanVideoTextEncode] 模型: {model_name}")
        print(f"[GJJ WanVideoTextEncode] 精度: {precision}")
        print(f"[GJJ WanVideoTextEncode] 量化: {quantization}")
        print(f"[GJJ WanVideoTextEncode] 设备: {device}")
        print(f"[GJJ WanVideoTextEncode] 使用磁盘缓存: {use_disk_cache}")

        # 运行时依赖检查
        try:
            wan_nodes = _load_wanvideo_nodes()
            wan_model_loading = _load_wanvideo_model_loading()
        except RuntimeError as e:
            _handle_runtime_dependency_error(e, unique_id=unique_id)
            raise
        except Exception as e:
            _handle_runtime_dependency_error(e, unique_id=unique_id)
            raise RuntimeError(
                f"GJJ 内置 WanVideo 文本编码加载失败。\n"
                f"错误信息: {e}\n"
                f"说明: 本节点使用 GJJ vendor/wanvideo_wrapper 内置运行时，不依赖外部 ComfyUI-WanVideoWrapper 插件。"
            ) from e

        LoadWanVideoT5TextEncoder = getattr(wan_model_loading, "LoadWanVideoT5TextEncoder")
        WanVideoTextEncode = getattr(wan_nodes, "WanVideoTextEncode")

        pbar = ProgressBar(3)

        echoshot = True if "[1]" in positive_prompt else False

        # 检查磁盘缓存
        if use_disk_cache:
            context, context_null = _get_cached_text_embeds(positive_prompt, negative_prompt)
            if context is not None and context_null is not None:
                print(f"[GJJ WanVideoTextEncode] ========== 使用缓存，跳过编码 ==========")
                return (
                    {
                        "prompt_embeds": context,
                        "negative_prompt_embeds": context_null,
                        "echoshot": echoshot,
                    },
                    {"prompt_embeds": context_null},
                    positive_prompt,
                )

        # 加载 T5 文本编码器
        print(f"[GJJ WanVideoTextEncode] 正在加载 T5 文本编码器...")
        load_device = "main_device" if device == "gpu" else "offload_device"
        t5, = LoadWanVideoT5TextEncoder().loadmodel(
            model_name=model_name,
            precision=precision,
            load_device=load_device,
            quantization=quantization,
        )
        pbar.update(1)
        print(f"[GJJ WanVideoTextEncode] T5 编码器加载完成")

        # 编码文本
        print(f"[GJJ WanVideoTextEncode] 正在编码文本提示词...")
        prompt_embeds_dict, = WanVideoTextEncode().process(
            positive_prompt=positive_prompt,
            negative_prompt=negative_prompt,
            t5=t5,
            force_offload=False,
            model_to_offload=None,
            use_disk_cache=use_disk_cache,
            device=device,
        )
        pbar.update(1)
        print(f"[GJJ WanVideoTextEncode] 文本编码完成")

        # 卸载 T5 编码器
        del t5
        mm.soft_empty_cache()
        gc.collect()
        pbar.update(1)

        # 保存到缓存
        if use_disk_cache:
            _save_text_embeds(
                positive_prompt,
                negative_prompt,
                prompt_embeds_dict.get("prompt_embeds"),
                prompt_embeds_dict.get("negative_prompt_embeds"),
            )

        print(f"[GJJ WanVideoTextEncode] ========== 编码完成 ==========")
        return (
            prompt_embeds_dict,
            {"prompt_embeds": prompt_embeds_dict["negative_prompt_embeds"]},
            positive_prompt,
        )


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_WanVideoTextEncodeCached}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: NODE_DISPLAY_NAME}

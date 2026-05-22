from __future__ import annotations

import gc
import hashlib
import os
import torch

import folder_paths
import comfy.model_management as mm
from comfy.utils import ProgressBar


NODE_NAME = "GJJ_WanVideoTextEncodeCached"


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
    DESCRIPTION = "编码文本提示词为文本嵌入，支持磁盘缓存加速。加载 T5 编码器后自动卸载，不占用显存。"
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

        wan_nodes = _load_wanvideo_nodes()
        wan_model_loading = _load_wanvideo_model_loading()
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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "📝 WanVideo 文本编码（缓存版）"}

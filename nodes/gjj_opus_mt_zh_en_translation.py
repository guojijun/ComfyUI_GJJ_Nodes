from __future__ import annotations

import gc
import os
from pathlib import Path
from typing import Any, Optional

import folder_paths
import torch
import comfy.model_management
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


NODE_NAME = "GJJ_OpusMTZhEnTranslation"

# 模型配置
OPUS_MT_MODEL_NAME = "opus-mt-zh-en"
OPUS_MT_MODEL_PATH = Path(folder_paths.models_dir) / "translation" / OPUS_MT_MODEL_NAME

# 模型缓存
_MODEL_CACHE: dict[str, tuple[AutoModelForSeq2SeqLM, AutoTokenizer]] = {}


def send_status(unique_id: Any, text: str) -> None:
    """发送状态更新到 ComfyUI 界面"""
    if not unique_id:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(
            "gjj_node_progress",
            {"node": str(unique_id), "text": str(text or "")},
        )
    except Exception:
        pass


def _ensure_model_downloaded() -> Path:
    """确保 opus-mt-zh-en 模型已下载到指定目录"""
    model_path = OPUS_MT_MODEL_PATH
    
    # 如果模型目录不存在，尝试从 Hugging Face 下载
    if not model_path.exists():
        model_path.mkdir(parents=True, exist_ok=True)
        send_status(None, f"正在下载 {OPUS_MT_MODEL_NAME} 模型到 {model_path}...")
        
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id=f"Helsinki-NLP/{OPUS_MT_MODEL_NAME}",
                local_dir=model_path,
                local_dir_use_symlinks=False,
                resume_download=True,
            )
            send_status(None, f"{OPUS_MT_MODEL_NAME} 模型下载完成！")
        except Exception as e:
            raise RuntimeError(f"下载 {OPUS_MT_MODEL_NAME} 模型失败: {e}")
    
    return model_path


def _load_model_and_tokenizer(device: torch.device) -> tuple[AutoModelForSeq2SeqLM, AutoTokenizer]:
    """加载模型和分词器"""
    cache_key = str(device)
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]
    
    model_path = _ensure_model_downloaded()
    
    try:
        # 加载分词器
        tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        
        # 加载模型
        model = AutoModelForSeq2SeqLM.from_pretrained(model_path, local_files_only=True)
        model.to(device)
        model.eval()
        
        _MODEL_CACHE[cache_key] = (model, tokenizer)
        return model, tokenizer
        
    except Exception as e:
        raise RuntimeError(f"加载 {OPUS_MT_MODEL_NAME} 模型失败: {e}")


def translate_text(
    text: str,
    device: torch.device,
    max_length: int = 512,
    batch_size: int = 8,
) -> str:
    """使用 opus-mt-zh-en 模型翻译中文到英文"""
    if not text.strip():
        return ""
    
    model, tokenizer = _load_model_and_tokenizer(device)
    
    try:
        # 分批处理长文本
        sentences = [s.strip() for s in text.split('\n') if s.strip()]
        translated_sentences = []
        
        for i in range(0, len(sentences), batch_size):
            batch = sentences[i:i + batch_size]
            
            # 编码输入
            inputs = tokenizer(
                batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=max_length,
            ).to(device)
            
            # 生成翻译
            with torch.no_grad():
                outputs = model.generate(
                    **inputs,
                    max_length=max_length,
                    num_beams=4,
                    early_stopping=True,
                )
            
            # 解码输出
            batch_translations = tokenizer.batch_decode(
                outputs, skip_special_tokens=True
            )
            translated_sentences.extend(batch_translations)
        
        return '\n'.join(translated_sentences)
        
    except Exception as e:
        raise RuntimeError(f"翻译过程中发生错误: {e}")


def unload_model() -> None:
    """卸载模型以释放显存"""
    global _MODEL_CACHE
    _MODEL_CACHE.clear()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


class GJJ_OpusMTZhEnTranslation:
    CATEGORY = "GJJ/翻译"
    FUNCTION = "translate"
    DESCRIPTION = "使用 Helsinki-NLP/opus-mt-zh-en 模型将中文翻译为英文。支持自动下载模型到 models/translation 目录。"
    SEARCH_ALIASES = ["translation", "opus mt", "中英翻译", "translation", "chinese to english"]
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文翻译结果",)
    OUTPUT_TOOLTIPS = ("翻译后的英文文本内容。",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "chinese_text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "display_name": "中文输入文本",
                    "tooltip": "输入需要翻译的中文文本。",
                }),
                "device": (["auto", "cpu", "gpu"], {
                    "default": "auto",
                    "display_name": "设备选择",
                    "tooltip": "选择运行模型的设备。auto 会自动选择 GPU（如果可用）或 CPU。",
                }),
                "max_length": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 1024,
                    "step": 64,
                    "display_name": "最大长度",
                    "tooltip": "输入和输出的最大 token 长度。",
                }),
                "batch_size": ("INT", {
                    "default": 8,
                    "min": 1,
                    "max": 32,
                    "step": 1,
                    "display_name": "批处理大小",
                    "tooltip": "同时处理的句子数量，影响内存使用和速度。",
                }),
                "unload_after_use": ("BOOLEAN", {
                    "default": False,
                    "display_name": "使用后卸载模型",
                    "tooltip": "翻译完成后是否卸载模型以释放显存。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def translate(
        self,
        chinese_text: str,
        device: str,
        max_length: int,
        batch_size: int,
        unload_after_use: bool,
        unique_id: Optional[str] = None,
    ) -> tuple[str]:
        """执行翻译操作"""
        try:
            # 确定设备
            if device == "auto":
                torch_device = comfy.model_management.get_torch_device()
            elif device == "gpu":
                if not torch.cuda.is_available():
                    raise RuntimeError("GPU 不可用，请选择 CPU 或 auto")
                torch_device = torch.device("cuda")
            else:  # cpu
                torch_device = torch.device("cpu")
            
            send_status(unique_id, "正在加载翻译模型...")
            
            # 执行翻译
            result = translate_text(
                chinese_text,
                torch_device,
                max_length=max_length,
                batch_size=batch_size,
            )
            
            send_status(unique_id, "翻译完成！")
            
            # 卸载模型（如果需要）
            if unload_after_use:
                send_status(unique_id, "正在卸载模型...")
                unload_model()
            
            return (result,)
            
        except Exception as e:
            # 确保在错误时也卸载模型（如果需要）
            if unload_after_use:
                unload_model()
            raise RuntimeError(f"翻译失败: {e}") from e


# 导出节点
NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_OpusMTZhEnTranslation}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "🌐 Opus-MT中英翻译器 🌍"}

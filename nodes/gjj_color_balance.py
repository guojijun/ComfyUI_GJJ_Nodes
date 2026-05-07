"""
GJJ 色彩平衡节点
调整图像的阴影、中间调和高光的色彩平衡。
"""
from __future__ import annotations

import torch

from .common_utils.types import GJJ_BATCH_IMAGE_TYPE


NODE_NAME = "GJJ_ColorBalance"
MIXED_BATCH_IMAGE_TYPE = f"{GJJ_BATCH_IMAGE_TYPE},IMAGE"


def _apply_color_balance(image: torch.Tensor,
                         shadows_red: float, shadows_green: float, shadows_blue: float,
                         midtones_red: float, midtones_green: float, midtones_blue: float,
                         highlights_red: float, highlights_green: float, highlights_blue: float,
                         preserve_luminosity: bool = False) -> torch.Tensor:
    """
    应用色彩平衡到图像（ComfyUI 系统节点算法）
    
    算法原理：
    1. 根据像素亮度将其分为阴影、中间调、高光三个区域
    2. 使用平滑过渡权重函数
    3. 对每个通道独立调整
    4. 可选保持亮度
    
    Args:
        image: 图像张量 [B, H, W, C] 或 [H, W, C]，范围 [0, 1]
        shadows_red/green/blue: 阴影调整值 (-100 到 100)
        midtones_red/green/blue: 中间调调整值 (-100 到 100)
        highlights_red/green/blue: 高光调整值 (-100 到 100)
        preserve_luminosity: 是否保持亮度
    
    Returns:
        调整后的图像张量 [B, H, W, C]
    """
    # 确保是4D张量 [B, H, W, C]
    if image.ndim == 3:
        image = image.unsqueeze(0)
    
    # 转换为浮点数并限制范围
    image = image.float().clamp(0.0, 1.0)
    
    # 计算亮度（Rec. 601 标准）
    luminance = (0.299 * image[:, :, :, 0] + 
                 0.587 * image[:, :, :, 1] + 
                 0.114 * image[:, :, :, 2])
    
    # 计算各区域的权重
    # 阴影权重：亮度越低权重越大，使用平滑曲线
    shadows_weight = torch.pow(1.0 - luminance, 2)
    
    # 高光权重：亮度越高权重越大，使用平滑曲线
    highlights_weight = torch.pow(luminance, 2)
    
    # 中间调权重：使用钟形曲线
    midtones_weight = 1.0 - shadows_weight - highlights_weight
    midtones_weight = torch.clamp(midtones_weight, 0.0, 1.0)
    
    # 归一化权重，确保总和为1
    total_weight = shadows_weight + midtones_weight + highlights_weight
    total_weight = torch.clamp(total_weight, 1e-8, 1.0)  # 避免除零
    
    shadows_weight = shadows_weight / total_weight
    midtones_weight = midtones_weight / total_weight
    highlights_weight = highlights_weight / total_weight
    
    # 将调整值从 -100~100 转换为 0~1 范围（映射到色彩调整范围）
    # ComfyUI 的实际算法：参数值 * 权重 * 调整系数
    shadows_r = shadows_red / 100.0
    shadows_g = shadows_green / 100.0
    shadows_b = shadows_blue / 100.0
    
    midtones_r = midtones_red / 100.0
    midtones_g = midtones_green / 100.0
    midtones_b = midtones_blue / 100.0
    
    highlights_r = highlights_red / 100.0
    highlights_g = highlights_green / 100.0
    highlights_b = highlights_blue / 100.0
    
    # 计算每个通道的调整量
    red_adjust = (shadows_r * shadows_weight + 
                  midtones_r * midtones_weight + 
                  highlights_r * highlights_weight)
    
    green_adjust = (shadows_g * shadows_weight + 
                    midtones_g * midtones_weight + 
                    highlights_g * highlights_weight)
    
    blue_adjust = (shadows_b * shadows_weight + 
                   midtones_b * midtones_weight + 
                   highlights_b * highlights_weight)
    
    # 应用调整
    result = image.clone()
    result[:, :, :, 0] = torch.clamp(image[:, :, :, 0] + red_adjust, 0.0, 1.0)
    result[:, :, :, 1] = torch.clamp(image[:, :, :, 1] + green_adjust, 0.0, 1.0)
    result[:, :, :, 2] = torch.clamp(image[:, :, :, 2] + blue_adjust, 0.0, 1.0)
    
    # 如果需要保持亮度
    if preserve_luminosity:
        # 计算原始亮度
        original_luminance = (0.299 * image[:, :, :, 0] + 
                            0.587 * image[:, :, :, 1] + 
                            0.114 * image[:, :, :, 2])
        
        # 计算调整后亮度
        adjusted_luminance = (0.299 * result[:, :, :, 0] + 
                            0.587 * result[:, :, :, 1] + 
                            0.114 * result[:, :, :, 2])
        
        # 计算亮度差异
        luminance_diff = adjusted_luminance - original_luminance
        
        # 计算缩放因子来保持亮度
        # 使用亮度比值来调整，而不是简单相减
        scale_factor = original_luminance / torch.clamp(adjusted_luminance, 1e-8, 1.0)
        
        # 应用缩放因子
        result[:, :, :, 0] = torch.clamp(result[:, :, :, 0] * scale_factor, 0.0, 1.0)
        result[:, :, :, 1] = torch.clamp(result[:, :, :, 1] * scale_factor, 0.0, 1.0)
        result[:, :, :, 2] = torch.clamp(result[:, :, :, 2] * scale_factor, 0.0, 1.0)
    
    return result


class GJJ_ColorBalance:
    """
    GJJ 色彩平衡节点
    调整图像的阴影、中间调和高光的色彩平衡。
    """
    NAME = NODE_NAME
    DISPLAY_NAME = "GJJ · 🎨 色彩平衡"
    CATEGORY = "GJJ"
    DESCRIPTION = "调整图像的阴影、中间调和高光的色彩平衡。与 ComfyUI 系统 Color Balance 节点功能一致，支持批量处理。"
    SEARCH_ALIASES = ["color balance", "色彩平衡", "色调", "调色", "shadows", "midtones", "highlights", "color correction"]
    
    FUNCTION = "apply"
    RETURN_TYPES = (MIXED_BATCH_IMAGE_TYPE,)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = ("应用色彩平衡后的图像。",)
    
    INPUT_IS_LIST = False
    OUTPUT_IS_LIST = (False,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (MIXED_BATCH_IMAGE_TYPE, {
                    "display_name": "image",
                    "tooltip": "输入图像（支持单图或批量）",
                }),
                "shadows_red": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "阴影-红",
                    "tooltip": "阴影区域红色通道调整 (-100 ~ 100)",
                }),
                "shadows_green": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "阴影-绿",
                    "tooltip": "阴影区域绿色通道调整 (-100 ~ 100)",
                }),
                "shadows_blue": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "阴影-蓝",
                    "tooltip": "阴影区域蓝色通道调整 (-100 ~ 100)",
                }),
                "midtones_red": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "中间调-红",
                    "tooltip": "中间调区域红色通道调整 (-100 ~ 100)",
                }),
                "midtones_green": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "中间调-绿",
                    "tooltip": "中间调区域绿色通道调整 (-100 ~ 100)",
                }),
                "midtones_blue": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "中间调-蓝",
                    "tooltip": "中间调区域蓝色通道调整 (-100 ~ 100)",
                }),
                "highlights_red": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "高光-红",
                    "tooltip": "高光区域红色通道调整 (-100 ~ 100)",
                }),
                "highlights_green": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "高光-绿",
                    "tooltip": "高光区域绿色通道调整 (-100 ~ 100)",
                }),
                "highlights_blue": ("FLOAT", {
                    "default": 0.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 1,
                    "display": "slider",
                    "display_name": "高光-蓝",
                    "tooltip": "高光区域蓝色通道调整 (-100 ~ 100)",
                }),
                "preserve_luminosity": ("BOOLEAN", {
                    "default": True,
                    "display_name": "保持亮度",
                    "tooltip": "保持整体亮度不变，避免色彩调整影响明暗",
                }),
            }
        }

    def apply(self,
              image,
              shadows_red=0.0,
              shadows_green=0.0,
              shadows_blue=0.0,
              midtones_red=0.0,
              midtones_green=0.0,
              midtones_blue=0.0,
              highlights_red=0.0,
              highlights_green=0.0,
              highlights_blue=0.0,
              preserve_luminosity=True):
        
        # 确保是4D张量 [B, H, W, C]
        if image.ndim == 3:
            image = image.unsqueeze(0)
        
        # 应用色彩平衡
        result = _apply_color_balance(
            image,
            shadows_red, shadows_green, shadows_blue,
            midtones_red, midtones_green, midtones_blue,
            highlights_red, highlights_green, highlights_blue,
            preserve_luminosity
        )
        
        return (result,)


# 注册
NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ColorBalance}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🎨 色彩平衡"}

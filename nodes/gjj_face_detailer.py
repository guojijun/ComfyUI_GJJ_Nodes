from __future__ import annotations

from typing import Any

import comfy.samplers
import torch
from nodes import MAX_RESOLUTION

from .gjj_impact_face_detailer_bridge import (
    available_bbox_models,
    available_sam_models,
    detailer_for_each_do_detail,
    empty_pil_tensor,
    ensure_model_paths,
    get_schedulers,
    load_bbox_detector,
    load_sam_model,
    make_sam_mask,
    segs_bitwise_and_mask,
    segs_to_combined_mask,
)


NODE_NAME = "GJJ_FaceDetailer"
SAM_DEVICE_MODES = ["AUTO", "Prefer GPU", "CPU"]
SAM_DETECTION_HINTS = [
    "center-1",
    "horizontal-2",
    "vertical-2",
    "rect-4",
    "diamond-4",
    "mask-area",
    "mask-points",
    "mask-point-bbox",
    "none",
]
SAM_NEGATIVE_HINT_OPTIONS = ["False", "Small", "Outter"]


def _scheduler_options() -> list[str]:
    values = list(get_schedulers())
    return values or ["normal"]


def _bbox_model_options() -> list[str]:
    ensure_model_paths()
    values = available_bbox_models()
    return values or [""]


def _sam_model_options() -> list[str]:
    ensure_model_paths()
    values = ["none"]
    values.extend(available_sam_models())
    return values


def _default_value(values: list[str], fallback: str = "") -> str:
    return values[0] if values else fallback


class GJJ_FaceDetailer:
    CATEGORY = "GJJ"
    FUNCTION = "detail_faces"
    SEARCH_ALIASES = [
        "face detailer",
        "人脸修复",
        "人脸细化",
        "局部重绘",
        "bbox",
        "sam",
        "detailer",
    ]
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("细化输出图像", "裁切细化图像", "透明裁切图像", "细化区域遮罩", "控制预览图像")
    OUTPUT_TOOLTIPS = (
        "最终完成人脸细化后的整张图像。",
        "每个检测区域单独细化后的裁切图像列表。",
        "带透明通道的裁切细化图像列表。",
        "本次参与细化的人脸区域合成遮罩。",
        "细化过程产生的 ControlNet 参考图列表；没有时会输出空占位图。",
    )
    OUTPUT_IS_LIST = (False, True, True, False, True)
    DESCRIPTION = (
        "GJJ 单节点版 FaceDetailer。内部直接加载 ultralytics bbox 人脸检测模型和 SAM 模型，"
        "无需额外连接 bbox_detector 或 sam_model 节点。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        bbox_models = _bbox_model_options()
        sam_models = _sam_model_options()
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要做人脸细化的图像。"}),
                "model": (
                    "MODEL",
                    {
                        "display_name": "扩散模型",
                        "tooltip": "用于人脸细化重绘的主模型；通常接 K 采样器同一路模型。",
                    },
                ),
                "clip": (
                    "CLIP",
                    {
                        "display_name": "CLIP 编码器",
                        "tooltip": "用于正反条件编码和局部重绘流程。",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "display_name": "VAE 解码器",
                        "tooltip": "用于图像和 latent 之间编码解码。",
                    },
                ),
                "positive": (
                    "CONDITIONING",
                    {
                        "display_name": "正面条件",
                        "tooltip": "传入局部细化时使用的正向条件。",
                    },
                ),
                "negative": (
                    "CONDITIONING",
                    {
                        "display_name": "反面条件",
                        "tooltip": "传入局部细化时使用的反向条件。",
                    },
                ),
                "bbox_model_name": (
                    bbox_models,
                    {
                        "default": _default_value(bbox_models),
                        "display_name": "人脸检测模型",
                        "tooltip": "从 ComfyUI/models/ultralytics/bbox 目录中选择人脸 bbox 检测模型。",
                    },
                ),
                "sam_model_name": (
                    sam_models,
                    {
                        "default": "none",
                        "display_name": "SAM 模型",
                        "tooltip": "可选的 SAM 细分模型；选 none 时只使用 bbox 检测结果。",
                    },
                ),
                "sam_device_mode": (
                    SAM_DEVICE_MODES,
                    {
                        "default": "AUTO",
                        "display_name": "SAM 运行设备",
                        "tooltip": "AUTO 为按需上 GPU，Prefer GPU 尽量常驻显存，CPU 始终在 CPU 运行。",
                    },
                ),
                "guide_size": (
                    "FLOAT",
                    {
                        "default": 512,
                        "min": 64,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "引导尺寸",
                        "tooltip": "细化时用于放大检测区域的目标尺寸。",
                    },
                ),
                "guide_size_for": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "bbox",
                        "label_off": "crop_region",
                        "display_name": "引导尺寸基准",
                        "tooltip": "开启时按 bbox 计算引导尺寸；关闭时按裁切区域计算。",
                    },
                ),
                "max_size": (
                    "FLOAT",
                    {
                        "default": 1024,
                        "min": 64,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "最大尺寸",
                        "tooltip": "检测区域放大后的上限尺寸，避免过大导致显存开销暴涨。",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "display_name": "随机种子",
                        "tooltip": "局部细化采样的随机种子。",
                    },
                ),
                "steps": (
                    "INT",
                    {
                        "default": 20,
                        "min": 1,
                        "max": 10000,
                        "display_name": "步数",
                        "tooltip": "局部细化采样步数。",
                    },
                ),
                "cfg": (
                    "FLOAT",
                    {
                        "default": 8.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "display_name": "CFG 引导强度",
                        "tooltip": "局部细化采样的 CFG 引导强度。",
                    },
                ),
                "sampler_name": (
                    comfy.samplers.KSampler.SAMPLERS,
                    {
                        "display_name": "采样器",
                        "tooltip": "局部细化时使用的采样器。",
                    },
                ),
                "scheduler": (
                    _scheduler_options(),
                    {
                        "default": "normal",
                        "display_name": "调度器",
                        "tooltip": "局部细化时使用的调度器。",
                    },
                ),
                "denoise": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0001,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "降噪强度",
                        "tooltip": "局部重绘的降噪强度，越高改动越明显。",
                    },
                ),
                "feather": (
                    "INT",
                    {
                        "default": 5,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "羽化",
                        "tooltip": "局部遮罩边缘羽化大小。",
                    },
                ),
                "noise_mask": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "启用",
                        "label_off": "关闭",
                        "display_name": "噪声遮罩",
                        "tooltip": "开启后在重绘时使用噪声遮罩。",
                    },
                ),
                "force_inpaint": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "启用",
                        "label_off": "关闭",
                        "display_name": "强制重绘模式",
                        "tooltip": "开启后强制按局部重绘逻辑执行。",
                    },
                ),
                "bbox_threshold": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "检测阈值",
                        "tooltip": "bbox 检测置信度阈值。",
                    },
                ),
                "bbox_dilation": (
                    "INT",
                    {
                        "default": 10,
                        "min": -512,
                        "max": 512,
                        "step": 1,
                        "display_name": "检测膨胀",
                        "tooltip": "对检测框进行膨胀或收缩。",
                    },
                ),
                "bbox_crop_factor": (
                    "FLOAT",
                    {
                        "default": 3.0,
                        "min": 1.0,
                        "max": 10.0,
                        "step": 0.1,
                        "display_name": "裁切扩展倍数",
                        "tooltip": "以检测框为基准扩展裁切区域的倍率。",
                    },
                ),
                "sam_detection_hint": (
                    SAM_DETECTION_HINTS,
                    {
                        "default": "center-1",
                        "display_name": "SAM 提示模式",
                        "tooltip": "SAM 细分时使用的提示点 / 提示框策略。",
                    },
                ),
                "sam_dilation": (
                    "INT",
                    {
                        "default": 0,
                        "min": -512,
                        "max": 512,
                        "step": 1,
                        "display_name": "SAM 膨胀",
                        "tooltip": "对 SAM 生成的遮罩做膨胀或收缩。",
                    },
                ),
                "sam_threshold": (
                    "FLOAT",
                    {
                        "default": 0.93,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "SAM 阈值",
                        "tooltip": "SAM 遮罩筛选阈值。",
                    },
                ),
                "sam_bbox_expansion": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "display_name": "SAM 检测框扩展",
                        "tooltip": "SAM 推理前额外扩展 bbox 的像素值。",
                    },
                ),
                "sam_mask_hint_threshold": (
                    "FLOAT",
                    {
                        "default": 0.7,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "display_name": "SAM 提示阈值",
                        "tooltip": "mask-area / mask-points 模式下使用的提示阈值。",
                    },
                ),
                "sam_mask_hint_use_negative": (
                    SAM_NEGATIVE_HINT_OPTIONS,
                    {
                        "default": "False",
                        "display_name": "SAM 负提示",
                        "tooltip": "控制 SAM 是否使用负提示点辅助细分。",
                    },
                ),
                "drop_size": (
                    "INT",
                    {
                        "default": 10,
                        "min": 1,
                        "max": MAX_RESOLUTION,
                        "step": 1,
                        "display_name": "最小目标尺寸",
                        "tooltip": "小于该尺寸的检测目标会被忽略。",
                    },
                ),
                "wildcard": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "display_name": "通配提示词",
                        "tooltip": "传给 FaceDetailer 的 wildcard 文本；留空时不额外附加。",
                    },
                ),
                "cycle": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 10,
                        "step": 1,
                        "display_name": "细化轮次",
                        "tooltip": "同一检测区域重复细化的轮次。",
                    },
                ),
            },
            "optional": {
                "detailer_hook": (
                    "DETAILER_HOOK",
                    {
                        "display_name": "细节修复钩子",
                        "tooltip": "可选的 Detailer Hook；若你后续继续迁移 Impact 相关 Hook 节点可直接复用。",
                    },
                ),
                "inpaint_model": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "启用",
                        "label_off": "关闭",
                        "display_name": "Inpaint 模型",
                        "tooltip": "如果主模型是 inpaint 模型，可开启此项。",
                    },
                ),
                "noise_mask_feather": (
                    "INT",
                    {
                        "default": 20,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "display_name": "噪声遮罩羽化",
                        "tooltip": "噪声遮罩边缘的额外羽化值。",
                    },
                ),
                "scheduler_func_opt": (
                    "SCHEDULER_FUNC",
                    {
                        "display_name": "调度函数",
                        "tooltip": "可选的调度函数输入，留给后续迁移 Impact 调度节点时复用。",
                    },
                ),
                "tiled_encode": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "启用",
                        "label_off": "关闭",
                        "display_name": "分块编码",
                        "tooltip": "使用分块 VAE 编码，适合大图降低显存压力。",
                    },
                ),
                "tiled_decode": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "启用",
                        "label_off": "关闭",
                        "display_name": "分块解码",
                        "tooltip": "使用分块 VAE 解码，适合大图降低显存压力。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs: Any):
        image = kwargs.get("image")
        image_shape = getattr(image, "shape", "")
        parts = [
            str(kwargs.get("bbox_model_name", "")),
            str(kwargs.get("sam_model_name", "")),
            str(kwargs.get("sam_device_mode", "")),
            str(kwargs.get("seed", "")),
            str(kwargs.get("steps", "")),
            str(kwargs.get("cfg", "")),
            str(kwargs.get("denoise", "")),
            str(kwargs.get("cycle", "")),
            str(image_shape),
        ]
        return "|".join(parts)

    def detail_faces(
        self,
        image,
        model,
        clip,
        vae,
        positive,
        negative,
        bbox_model_name,
        sam_model_name,
        sam_device_mode,
        guide_size,
        guide_size_for,
        max_size,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        feather,
        noise_mask,
        force_inpaint,
        bbox_threshold,
        bbox_dilation,
        bbox_crop_factor,
        sam_detection_hint,
        sam_dilation,
        sam_threshold,
        sam_bbox_expansion,
        sam_mask_hint_threshold,
        sam_mask_hint_use_negative,
        drop_size,
        wildcard,
        cycle,
        detailer_hook=None,
        inpaint_model=False,
        noise_mask_feather=0,
        scheduler_func_opt=None,
        tiled_encode=False,
        tiled_decode=False,
    ):
        bbox_detector = load_bbox_detector(bbox_model_name)
        sam_model = load_sam_model(sam_model_name, sam_device_mode)

        result_img = None
        result_mask = None
        result_cropped_enhanced = []
        result_cropped_enhanced_alpha = []
        result_cnet_images = []

        if len(image) > 1:
            import logging
            logging.warning("[GJJ] 人脸细化器不是视频细化节点；批量输入时会逐帧串行处理。")

        for index, single_image in enumerate(image):
            frame = single_image.unsqueeze(0)
            bbox_detector.setAux("face")
            segs = bbox_detector.detect(frame, bbox_threshold, bbox_dilation, bbox_crop_factor, drop_size, detailer_hook=detailer_hook)
            bbox_detector.setAux(None)

            if sam_model is not None:
                sam_mask = make_sam_mask(
                    sam_model,
                    segs,
                    frame,
                    sam_detection_hint,
                    sam_dilation,
                    sam_threshold,
                    sam_bbox_expansion,
                    sam_mask_hint_threshold,
                    sam_mask_hint_use_negative,
                )
                segs = segs_bitwise_and_mask(segs, sam_mask)

            if len(segs[1]) > 0:
                enhanced_img, _cropped_list, cropped_enhanced, cropped_enhanced_alpha, cnet_pil_list, _new_segs = detailer_for_each_do_detail(
                    frame,
                    segs,
                    model,
                    clip,
                    vae,
                    guide_size,
                    guide_size_for,
                    max_size,
                    seed + index,
                    steps,
                    cfg,
                    sampler_name,
                    scheduler,
                    positive,
                    negative,
                    denoise,
                    feather,
                    noise_mask,
                    force_inpaint,
                    wildcard_opt=wildcard,
                    detailer_hook=detailer_hook,
                    cycle=cycle,
                    inpaint_model=inpaint_model,
                    noise_mask_feather=noise_mask_feather,
                    scheduler_func_opt=scheduler_func_opt,
                    tiled_encode=tiled_encode,
                    tiled_decode=tiled_decode,
                )
            else:
                enhanced_img = frame
                cropped_enhanced = []
                cropped_enhanced_alpha = []
                cnet_pil_list = []

            mask = segs_to_combined_mask(segs)

            if len(cropped_enhanced) == 0:
                cropped_enhanced = [empty_pil_tensor()]
            if len(cropped_enhanced_alpha) == 0:
                cropped_enhanced_alpha = [empty_pil_tensor()]
            if len(cnet_pil_list) == 0:
                cnet_pil_list = [empty_pil_tensor()]

            result_img = enhanced_img if result_img is None else torch.cat((result_img, enhanced_img), dim=0)
            result_mask = mask if result_mask is None else torch.cat((result_mask, mask), dim=0)
            result_cropped_enhanced.extend(cropped_enhanced)
            result_cropped_enhanced_alpha.extend(cropped_enhanced_alpha)
            result_cnet_images.extend(cnet_pil_list)

        return result_img, result_cropped_enhanced, result_cropped_enhanced_alpha, result_mask, result_cnet_images


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_FaceDetailer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 😃 人脸细化器"}

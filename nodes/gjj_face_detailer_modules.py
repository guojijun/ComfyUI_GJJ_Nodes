from __future__ import annotations

import comfy.samplers
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


NODE_PREFIX = "GJJ_FaceDetailerModule"
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


def _default_value(values: list[str], fallback: str = "") -> str:
    return values[0] if values else fallback


class GJJ_BBoxDetectorLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load"
    DESCRIPTION = "从 models/ultralytics/bbox 目录加载人脸或目标检测模型，供 SEGS 检测流程复用。"
    RETURN_TYPES = ("BBOX_DETECTOR",)
    RETURN_NAMES = ("边框检测模型",)
    OUTPUT_TOOLTIPS = ("从 models/ultralytics/bbox 中加载的人脸 bbox 检测器。",)
    SEARCH_ALIASES = ["bbox detector", "ultralytics", "face detector", "人脸检测"]

    @classmethod
    def INPUT_TYPES(cls):
        ensure_model_paths()
        bbox_models = available_bbox_models() or [""]
        return {
            "required": {
                "bbox_model_name": (
                    bbox_models,
                    {
                        "default": _default_value(bbox_models),
                        "display_name": "BBox模型",
                        "tooltip": "从 ComfyUI/models/ultralytics/bbox 中选择检测模型。",
                    },
                ),
            }
        }

    def load(self, bbox_model_name):
        return (load_bbox_detector(bbox_model_name),)


class GJJ_SAMModelLoader:
    CATEGORY = "GJJ"
    FUNCTION = "load"
    DESCRIPTION = "从 models/sams 目录加载 SAM 模型，供遮罩细分和人脸细化流程复用。"
    RETURN_TYPES = ("SAM_MODEL",)
    RETURN_NAMES = ("分割模型输出",)
    OUTPUT_TOOLTIPS = ("从 models/sams 中加载的 SAM 模型。",)
    SEARCH_ALIASES = ["sam model", "sam loader", "segment anything", "细分模型"]

    @classmethod
    def INPUT_TYPES(cls):
        ensure_model_paths()
        sam_models = ["none"] + available_sam_models()
        return {
            "required": {
                "sam_model_name": (
                    sam_models,
                    {
                        "default": "none",
                        "display_name": "SAM模型",
                        "tooltip": "从 ComfyUI/models/sams 中选择模型；none 表示不加载。",
                    },
                ),
                "device_mode": (
                    SAM_DEVICE_MODES,
                    {
                        "default": "AUTO",
                        "display_name": "运行设备",
                        "tooltip": "AUTO 按需上 GPU，Prefer GPU 尽量常驻显存，CPU 始终在 CPU 运行。",
                    },
                ),
            }
        }

    def load(self, sam_model_name, device_mode):
        return (load_sam_model(sam_model_name, device_mode),)


class GJJ_DetectSEGS:
    CATEGORY = "GJJ"
    FUNCTION = "detect"
    DESCRIPTION = "使用 BBox 检测器从输入图像中识别目标区域，并转换成后续细化节点可用的 SEGS。"
    RETURN_TYPES = ("SEGS",)
    RETURN_NAMES = ("检测区域结果",)
    OUTPUT_TOOLTIPS = ("使用 bbox 检测器从图像中生成 SEGS 片段集合。",)
    SEARCH_ALIASES = ["segs detect", "bbox to segs", "检测片段", "区域检测"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bbox_detector": ("BBOX_DETECTOR", {"display_name": "BBox检测器", "tooltip": "接入 GJJ 的 BBox 检测器。"}),
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要检测人脸区域的图像。"}),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "检测阈值", "tooltip": "bbox 检测置信度阈值。"}),
                "dilation": ("INT", {"default": 10, "min": -512, "max": 512, "step": 1, "display_name": "膨胀", "tooltip": "检测框的膨胀或收缩。"}),
                "crop_factor": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 10.0, "step": 0.1, "display_name": "裁切扩展倍数", "tooltip": "根据检测框扩展出裁切区域。"}),
                "drop_size": ("INT", {"default": 10, "min": 1, "max": MAX_RESOLUTION, "step": 1, "display_name": "最小尺寸", "tooltip": "忽略过小的检测目标。"}),
            },
            "optional": {
                "detailer_hook": ("DETAILER_HOOK", {"display_name": "细节修复钩子", "tooltip": "可选检测钩子。"}),
            },
        }

    def detect(self, bbox_detector, image, threshold, dilation, crop_factor, drop_size, detailer_hook=None):
        return (bbox_detector.detect(image, threshold, dilation, crop_factor, drop_size, detailer_hook=detailer_hook),)


class GJJ_MakeSAMMask:
    CATEGORY = "GJJ"
    FUNCTION = "generate"
    DESCRIPTION = "基于 SAM 模型和已有 SEGS 生成更精细的局部遮罩，并输出与遮罩相交后的 SEGS。"
    RETURN_TYPES = ("MASK", "SEGS")
    RETURN_NAMES = ("分割遮罩结果", "筛选区域结果")
    OUTPUT_TOOLTIPS = (
        "SAM 生成的细分遮罩，可用于观察细化区域。",
        "将原始 SEGS 与 SAM 遮罩做相交后得到的过滤结果。",
    )
    SEARCH_ALIASES = ["sam mask", "sam segs", "细分遮罩", "遮罩过滤"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sam_model": ("SAM_MODEL", {"display_name": "SAM模型", "tooltip": "通过 GJJ 的 SAM 模型加载器加载的模型。"}),
                "segs": ("SEGS", {"display_name": "输入SEGS", "tooltip": "待细分的人脸 SEGS。"}),
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "原始图像，供 SAM 进行掩码预测。"}),
                "detection_hint": (SAM_DETECTION_HINTS, {"default": "center-1", "display_name": "提示模式", "tooltip": "SAM 检测提示策略。"}),
                "dilation": ("INT", {"default": 0, "min": -512, "max": 512, "step": 1, "display_name": "遮罩膨胀", "tooltip": "对 SAM 结果做膨胀或收缩。"}),
                "threshold": ("FLOAT", {"default": 0.93, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "SAM阈值", "tooltip": "SAM 遮罩筛选阈值。"}),
                "bbox_expansion": ("INT", {"default": 0, "min": 0, "max": 1000, "step": 1, "display_name": "BBox扩展", "tooltip": "SAM 推理前额外扩展 bbox。"}),
                "mask_hint_threshold": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.01, "display_name": "提示阈值", "tooltip": "mask-area / mask-points 模式使用的阈值。"}),
                "mask_hint_use_negative": (SAM_NEGATIVE_HINT_OPTIONS, {"default": "False", "display_name": "负提示", "tooltip": "控制是否使用负提示点。"}),
            }
        }

    def generate(self, sam_model, segs, image, detection_hint, dilation, threshold, bbox_expansion, mask_hint_threshold, mask_hint_use_negative):
        mask = make_sam_mask(
            sam_model,
            segs,
            image,
            detection_hint,
            dilation,
            threshold,
            bbox_expansion,
            mask_hint_threshold,
            mask_hint_use_negative,
        )
        return mask, segs_bitwise_and_mask(segs, mask)


class GJJ_SEGSBitwiseAndMask:
    CATEGORY = "GJJ"
    FUNCTION = "apply"
    DESCRIPTION = "将 SEGS 与遮罩做按位相交，只保留被遮罩覆盖的检测区域。"
    RETURN_TYPES = ("SEGS",)
    RETURN_NAMES = ("筛选区域结果",)
    OUTPUT_TOOLTIPS = ("把 SEGS 与遮罩做相交，保留遮罩覆盖区域。",)
    SEARCH_ALIASES = ["segs and mask", "segs filter", "片段过滤"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "segs": ("SEGS", {"display_name": "输入SEGS", "tooltip": "待过滤的 SEGS。"}),
                "mask": ("MASK", {"display_name": "遮罩", "tooltip": "用于过滤 SEGS 的遮罩。"}),
            }
        }

    def apply(self, segs, mask):
        return (segs_bitwise_and_mask(segs, mask),)


class GJJ_SEGSToMask:
    CATEGORY = "GJJ"
    FUNCTION = "combine"
    DESCRIPTION = "把多个 SEGS 区域合并成一张统一遮罩，方便调试或继续送入其它局部处理节点。"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("合并遮罩结果",)
    OUTPUT_TOOLTIPS = ("将 SEGS 合成为单张遮罩。",)
    SEARCH_ALIASES = ["segs to mask", "combine segs", "合并遮罩"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"segs": ("SEGS", {"display_name": "输入SEGS", "tooltip": "需要合并的 SEGS。"})}}

    def combine(self, segs):
        return (segs_to_combined_mask(segs),)


class GJJ_DetailerForEach:
    CATEGORY = "GJJ"
    FUNCTION = "detail"
    DESCRIPTION = "对输入的每个 SEGS 区域逐项进行局部重绘和细化，并返回整图、裁切图和新的 SEGS。"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "SEGS", "IMAGE")
    RETURN_NAMES = ("细化输出图像", "裁切原始图像", "裁切细化图像", "细化区域结果", "控制预览图像")
    OUTPUT_TOOLTIPS = (
        "对输入 SEGS 逐项细化后的整图。",
        "每个细化区域的裁切原图列表。",
        "每个细化区域的裁切细化图列表。",
        "细化后生成的新 SEGS。",
        "细化过程中产生的 ControlNet 参考图列表；没有时会输出空占位图。",
    )
    OUTPUT_IS_LIST = (False, True, True, False, True)
    SEARCH_ALIASES = ["detailer for each", "segs detail", "逐项细化", "局部细化"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "输入图像", "tooltip": "需要执行局部细化的原始图像。"}),
                "segs": ("SEGS", {"display_name": "输入SEGS", "tooltip": "要逐项细化的检测区域集合。"}),
                "model": ("MODEL", {"display_name": "扩散模型", "tooltip": "局部细化使用的扩散模型。"}),
                "clip": ("CLIP", {"display_name": "CLIP 编码器", "tooltip": "局部细化使用的 CLIP。"}),
                "vae": ("VAE", {"display_name": "VAE 解码器", "tooltip": "局部细化使用的 VAE。"}),
                "positive": ("CONDITIONING", {"display_name": "正面条件", "tooltip": "细化时使用的正向条件。"}),
                "negative": ("CONDITIONING", {"display_name": "反面条件", "tooltip": "细化时使用的反向条件。"}),
                "guide_size": ("FLOAT", {"default": 512, "min": 64, "max": MAX_RESOLUTION, "step": 8, "display_name": "引导尺寸", "tooltip": "细化时目标放大尺寸。"}),
                "guide_size_for": ("BOOLEAN", {"default": True, "label_on": "bbox", "label_off": "crop_region", "display_name": "引导尺寸基准", "tooltip": "按 bbox 或按 crop_region 计算尺寸。"}),
                "max_size": ("FLOAT", {"default": 1024, "min": 64, "max": MAX_RESOLUTION, "step": 8, "display_name": "最大尺寸", "tooltip": "放大后允许的最大尺寸。"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "display_name": "随机种子", "tooltip": "局部细化采样种子。"}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000, "display_name": "步数", "tooltip": "局部细化采样步数。"}),
                "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "display_name": "CFG 引导强度", "tooltip": "局部细化 CFG。"}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"display_name": "采样器", "tooltip": "局部细化采样器。"}),
                "scheduler": (_scheduler_options(), {"default": "normal", "display_name": "调度器", "tooltip": "局部细化调度器。"}),
                "denoise": ("FLOAT", {"default": 0.5, "min": 0.0001, "max": 1.0, "step": 0.01, "display_name": "降噪强度", "tooltip": "局部重绘的降噪强度。"}),
                "feather": ("INT", {"default": 5, "min": 0, "max": 100, "step": 1, "display_name": "羽化", "tooltip": "局部遮罩边缘羽化大小。"}),
                "noise_mask": ("BOOLEAN", {"default": True, "label_on": "启用", "label_off": "关闭", "display_name": "噪声遮罩", "tooltip": "是否在重绘时使用噪声遮罩。"}),
                "force_inpaint": ("BOOLEAN", {"default": True, "label_on": "启用", "label_off": "关闭", "display_name": "强制重绘", "tooltip": "是否强制按 inpaint 逻辑执行。"}),
                "wildcard": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False, "display_name": "通配提示词", "tooltip": "传入 DetailerForEach 的 wildcard 文本。"}),
                "cycle": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1, "display_name": "细化轮次", "tooltip": "同一检测区域重复细化次数。"}),
            },
            "optional": {
                "detailer_hook": ("DETAILER_HOOK", {"display_name": "细节修复钩子", "tooltip": "可选细化钩子。"}),
                "inpaint_model": ("BOOLEAN", {"default": False, "label_on": "启用", "label_off": "关闭", "display_name": "Inpaint模型", "tooltip": "主模型为 inpaint 模型时可开启。"}),
                "noise_mask_feather": ("INT", {"default": 20, "min": 0, "max": 100, "step": 1, "display_name": "噪声遮罩羽化", "tooltip": "噪声遮罩的额外羽化值。"}),
                "scheduler_func_opt": ("SCHEDULER_FUNC", {"display_name": "调度函数", "tooltip": "可选调度函数输入。"}),
                "tiled_encode": ("BOOLEAN", {"default": False, "label_on": "启用", "label_off": "关闭", "display_name": "分块编码", "tooltip": "用分块 VAE 编码降低显存。"}),
                "tiled_decode": ("BOOLEAN", {"default": False, "label_on": "启用", "label_off": "关闭", "display_name": "分块解码", "tooltip": "用分块 VAE 解码降低显存。"}),
            },
        }

    def detail(self, image, segs, model, clip, vae, positive, negative, guide_size, guide_size_for, max_size, seed, steps, cfg, sampler_name, scheduler, denoise, feather, noise_mask, force_inpaint, wildcard, cycle, detailer_hook=None, inpaint_model=False, noise_mask_feather=0, scheduler_func_opt=None, tiled_encode=False, tiled_decode=False):
        enhanced_img, cropped_list, enhanced_list, _enhanced_alpha_list, cnet_pil_list, new_segs = detailer_for_each_do_detail(
            image,
            segs,
            model,
            clip,
            vae,
            guide_size,
            guide_size_for,
            max_size,
            seed,
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

        if len(cnet_pil_list) == 0:
            cnet_pil_list = [empty_pil_tensor()]

        return enhanced_img, cropped_list, enhanced_list, new_segs, cnet_pil_list


NODE_CLASS_MAPPINGS = {
    f"{NODE_PREFIX}_BBoxDetectorLoader": GJJ_BBoxDetectorLoader,
    f"{NODE_PREFIX}_SAMModelLoader": GJJ_SAMModelLoader,
    f"{NODE_PREFIX}_DetectSEGS": GJJ_DetectSEGS,
    f"{NODE_PREFIX}_MakeSAMMask": GJJ_MakeSAMMask,
    f"{NODE_PREFIX}_SEGSBitwiseAndMask": GJJ_SEGSBitwiseAndMask,
    f"{NODE_PREFIX}_SEGSToMask": GJJ_SEGSToMask,
    f"{NODE_PREFIX}_DetailerForEach": GJJ_DetailerForEach,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    f"{NODE_PREFIX}_BBoxDetectorLoader": "GJJ · 🔎 BBox检测器加载器",
    f"{NODE_PREFIX}_SAMModelLoader": "GJJ · 🧩 SAM模型加载器",
    f"{NODE_PREFIX}_DetectSEGS": "GJJ · 🧭 BBox转SEGS",
    f"{NODE_PREFIX}_MakeSAMMask": "GJJ · 🎭 SAM遮罩生成器",
    f"{NODE_PREFIX}_SEGSBitwiseAndMask": "GJJ · 🧹 SEGS遮罩过滤",
    f"{NODE_PREFIX}_SEGSToMask": "GJJ · 🧱 SEGS合并遮罩",
    f"{NODE_PREFIX}_DetailerForEach": "GJJ · ✨ 逐项细化器",
}

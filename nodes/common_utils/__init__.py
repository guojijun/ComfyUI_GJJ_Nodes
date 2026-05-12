# GJJ 公共工具函数模块
# 所有跨节点复用的公共函数统一存放在此目录
# 严禁导入其他节点代码，保持零依赖

from .types import (
	# 类型定义
	GJJ_BATCH_IMAGE_TYPE,
)

from .model_manager import (
	# 模型关键词加载
	gjjutils_load_model_keywords,
	# 模型模糊搜索
	gjjutils_search_models,
	# 在文件夹中查找模型
	gjjutils_find_model_in_folders,
	# 获取类别可用模型
	gjjutils_get_available_models_by_category,
	# 构建模型选择列表
	gjjutils_build_model_choices,
)

from .model_loader import (
	# LTX 2.3 模型加载
	gjjutils_load_ltx23_models,
	DEFAULT_LTX23_CKPT_CANDIDATES,
	DEFAULT_LTX23_VIDEO_VAE_CANDIDATES,
	DEFAULT_LTX23_AUDIO_VAE_CANDIDATES,
	DEFAULT_LTX23_TEXT_ENCODER_CANDIDATES,
	# WAN 2.2 模型加载
	gjjutils_load_wan22_models,
	DEFAULT_WAN22_CKPT_CANDIDATES,
	DEFAULT_WAN22_MAIN_UNET_CANDIDATES,
	DEFAULT_WAN22_AUX_UNET_CANDIDATES,
	DEFAULT_WAN22_CLIP_CANDIDATES,
	DEFAULT_WAN22_VAE_CANDIDATES,
	# 通用工具
	gjjutils_detect_model_family,
	gjjutils_get_model_loader,
)

from .text_tools import (
	# 文本规范化
	gjjutils_normalize_text,
	gjjutils_canonical_model_text,
	# 名称匹配与选择
	gjjutils_pick_available_name,
	# 列表处理
	gjjutils_dedupe_keep_order,
	# 路径处理
	gjjutils_extract_basename,
	gjjutils_extract_stem,
)

from .model_family import (
	# 模型族匹配
	gjjutils_model_family_match_preset,
	# CLIP 类型解析
	gjjutils_model_family_resolve_clip_type,
	# CLIP 名称解析
	gjjutils_model_family_resolve_clip_names,
	# LoRA 名称选择
	gjjutils_model_family_pick_lora_name,
	# 模型名称选择
	gjjutils_model_family_pick_model_name,
	# Flux CLIP 候选
	gjjutils_model_family_get_flux_clip_candidates,
	# 模型名称解析工具（新增）
	gjjutils_pick_available_model_name,
	gjjutils_model_basename,
	gjjutils_model_stem,
	# 预设表加载工具（新增）
	gjjutils_load_model_family_presets,
	gjjutils_match_model_family_preset,
	# 常量导出
	MODEL_FAMILY_PRESETS,
	CLIP_TYPE_KEYWORDS,
	DEFAULT_CLIP_NAME,
	DEFAULT_VAE_NAME,
)

from .sampler_tools import (
	# Flux2 相关
	gjjutils_EmptyFlux2LatentImage,
	gjjutils_Flux2Scheduler,
	# 手动 Sigma
	gjjutils_ManualSigmas,
	# 采样器相关
	gjjutils_RandomNoise,
	gjjutils_KSamplerSelect,
	gjjutils_CFGGuider,
	gjjutils_SamplerCustomAdvanced,
	# 兼容接口（模拟 .execute() 调用）
	EmptyFlux2LatentImage_execute,
	Flux2Scheduler_execute,
	ManualSigmas_execute,
	RandomNoise_execute,
	KSamplerSelect_execute,
	CFGGuider_execute,
	SamplerCustomAdvanced_execute,
)

from .video_tools import (
	# LTX 视频相关
	gjjutils_EmptyLTXVLatentVideo,
	gjjutils_LTXVAddGuide,
	gjjutils_LTXVConcatAVLatent,
	gjjutils_LTXVSeparateAVLatent,
	gjjutils_LTXVConditioning,
	gjjutils_LTXVCropGuides,
	# 通用视频处理
	gjjutils_CreateVideo,
	gjjutils_GetVideoComponents,
	# 上采样工具
	gjjutils_LatentUpscaleModelLoader,
	gjjutils_LTXVLatentUpsampler,
	# 兼容接口
	EmptyLTXVLatentVideo_execute,
	LTXVAddGuide_execute,
	LTXVConcatAVLatent_execute,
	LTXVSeparateAVLatent_execute,
	LTXVConditioning_execute,
	LTXVCropGuides_execute,
	CreateVideo_execute,
	GetVideoComponents_execute,
	LatentUpscaleModelLoader_execute,
	LTXVLatentUpsampler_execute,
)

from .audio_tools import (
	# LTX 音频相关
	gjjutils_LTXVEmptyLatentAudio,
	gjjutils_LTXVAudioVAELoader,
	gjjutils_LTXVAudioVAEEncode,
	gjjutils_LTXVAudioVAEDecode,
	gjjutils_LTXAVTextEncoderLoader,
	# 通用音频处理
	gjjutils_vae_decode_audio,
	# 兼容接口
	LTXVEmptyLatentAudio_execute,
	LTXVAudioVAELoader_execute,
	LTXVAudioVAEEncode_execute,
	LTXVAudioVAEDecode_execute,
	LTXAVTextEncoderLoader_execute,
	vae_decode_audio_execute,
)

from .mask_tools import (
	# 遮罩操作
	gjjutils_GrowMask,
	# 兼容接口
	GrowMask_execute,
)

from .image_tools import (
	# 图像扩图
	gjjutils_expand_image_with_padding,
	gjjutils_create_expand_mask,
	gjjutils_resize_image_to_size,
	gjjutils_calculate_expand_size,
	gjjutils_blend_mask_edge,
	gjjutils_split_image_batch,
)

from .cfg_tools import (
	# CFG 归一化
	gjjutils_CFGNorm,
	# 兼容接口
	CFGNorm_execute,
)

from .try_handler import (
	# try-except 通用处理
	gjj_try_except_handler,
	gjj_try_import,
	gjj_safe_execute,
)

from .tsv_translation import (
	# 翻译工具
	DEFAULT_TRANSLATION_TSV,
	TRANSLATION_ROOT,
	TranslationTable,
	load_translation_table,
	normalize_translation_key,
	normalize_translation_text,
	translate_term,
	translate_text_by_terms,
	translate_text_to_chinese,
	translate_text_to_english,
	translate_to_chinese,
	translate_to_english,
)

from . import rmbg2_model

__all__ = [
	# types
	"GJJ_BATCH_IMAGE_TYPE",
	# model_manager（新增）
	"gjjutils_load_model_keywords",
	"gjjutils_search_models",
	"gjjutils_find_model_in_folders",
	"gjjutils_get_available_models_by_category",
	"gjjutils_build_model_choices",
	# text_tools（新增）
	"gjjutils_normalize_text",
	"gjjutils_canonical_model_text",
	"gjjutils_pick_available_name",
	"gjjutils_dedupe_keep_order",
	"gjjutils_extract_basename",
	"gjjutils_extract_stem",
	# model_family
	"gjjutils_model_family_match_preset",
	"gjjutils_model_family_resolve_clip_type",
	"gjjutils_model_family_resolve_clip_names",
	"gjjutils_model_family_pick_lora_name",
	"gjjutils_model_family_pick_model_name",
	"gjjutils_model_family_get_flux_clip_candidates",
	# 模型名称解析工具（新增）
	"gjjutils_pick_available_model_name",
	"gjjutils_model_basename",
	"gjjutils_model_stem",
	# 预设表加载工具（新增）
	"gjjutils_load_model_family_presets",
	"gjjutils_match_model_family_preset",
	# 常量导出
	MODEL_FAMILY_PRESETS,
	"CLIP_TYPE_KEYWORDS",
	"DEFAULT_CLIP_NAME",
	"DEFAULT_VAE_NAME",
	# sampler_tools
	"gjjutils_EmptyFlux2LatentImage",
	"gjjutils_Flux2Scheduler",
	"gjjutils_ManualSigmas",
	"gjjutils_RandomNoise",
	"gjjutils_KSamplerSelect",
	"gjjutils_CFGGuider",
	"gjjutils_SamplerCustomAdvanced",
	"EmptyFlux2LatentImage_execute",
	"Flux2Scheduler_execute",
	"ManualSigmas_execute",
	"RandomNoise_execute",
	"KSamplerSelect_execute",
	"CFGGuider_execute",
	"SamplerCustomAdvanced_execute",
	# video_tools
	"gjjutils_EmptyLTXVLatentVideo",
	"gjjutils_LTXVAddGuide",
	"gjjutils_LTXVConcatAVLatent",
	"gjjutils_LTXVSeparateAVLatent",
	"gjjutils_LTXVConditioning",
	"gjjutils_LTXVCropGuides",
	"gjjutils_CreateVideo",
	"gjjutils_GetVideoComponents",
	"gjjutils_LatentUpscaleModelLoader",
	"gjjutils_LTXVLatentUpsampler",
	"EmptyLTXVLatentVideo_execute",
	"LTXVAddGuide_execute",
	"LTXVConcatAVLatent_execute",
	"LTXVSeparateAVLatent_execute",
	"LTXVConditioning_execute",
	"LTXVCropGuides_execute",
	"CreateVideo_execute",
	"GetVideoComponents_execute",
	"LatentUpscaleModelLoader_execute",
	"LTXVLatentUpsampler_execute",
	# audio_tools
	"gjjutils_LTXVEmptyLatentAudio",
	"gjjutils_LTXVAudioVAELoader",
	"gjjutils_LTXVAudioVAEEncode",
	"gjjutils_LTXVAudioVAEDecode",
	"gjjutils_LTXAVTextEncoderLoader",
	"gjjutils_vae_decode_audio",
	"LTXVEmptyLatentAudio_execute",
	"LTXVAudioVAELoader_execute",
	"LTXVAudioVAEEncode_execute",
	"LTXVAudioVAEDecode_execute",
	"LTXAVTextEncoderLoader_execute",
	"vae_decode_audio_execute",
	# mask_tools
	"gjjutils_GrowMask",
	"GrowMask_execute",
	# image_tools
	"gjjutils_expand_image_with_padding",
	"gjjutils_create_expand_mask",
	"gjjutils_resize_image_to_size",
	"gjjutils_calculate_expand_size",
	"gjjutils_blend_mask_edge",
	"gjjutils_split_image_batch",
	# cfg_tools
	"gjjutils_CFGNorm",
	"CFGNorm_execute",
	# try_handler
	"gjj_try_except_handler",
	"gjj_try_import",
	"gjj_safe_execute",
	# tsv_translation
	"DEFAULT_TRANSLATION_TSV",
	"TRANSLATION_ROOT",
	"TranslationTable",
	"load_translation_table",
	"normalize_translation_key",
	"normalize_translation_text",
	"translate_term",
	"translate_text_by_terms",
	"translate_text_to_chinese",
	"translate_text_to_english",
	"translate_to_chinese",
	"translate_to_english",
]

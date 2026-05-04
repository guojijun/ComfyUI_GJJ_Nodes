from __future__ import annotations
import re,gc,torch
from dataclasses import dataclass, field
from typing import Any
import torch.nn.functional as F
from .batch_image_type import GJJ_BATCH_IMAGE_TYPE
from .gjj_sam3_runtime import (comfy_image_to_pil,get_or_build_model,list_sam3_models,masks_to_comfy_mask,pick_available_name,)

try:from ..utils.tsv_translation import translate_text_to_english, translate_to_english
except Exception:from utils.tsv_translation import translate_text_to_english, translate_to_english


NODE_NAME = "GJJ_BatchTextSegmenter"
DEFAULT_PROMPT = "图1：帽子和眼镜；图2：衣服、鞋子"
DEFAULT_WARNING = "等待执行"
DEFAULT_SAM3_MODEL = "sam3.safetensors"
CN_NUMBERS={"零": 0,"〇": 0,"一": 1,"二": 2,"两": 2,"三": 3,"四": 4,"五": 5, "六": 6,"七": 7, "八": 8, "九": 9,}
TARGET_SPLIT_RE = re.compile(r"[、,，/+＋&\s]+|和|与|及|以及|还有|并且")
STOPWORDS={"中","里","里面","中的","里的","里面的","图","图片","张","第","这个","那个","需要","请","分割","裁剪", "保留","区域","目标","物体", "对象","出来", "一下",}
POSITION_HINTS={"帽": (0.18,0.00,0.82,0.30),"头": (0.18,0.00,0.82,0.38),"发": (0.18,0.00,0.82,0.36),"脸": (0.20,0.10,0.80,0.48),"眼": (0.20,0.12,0.80,0.42),"镜": (0.18,0.10,0.82,0.45),"耳": (0.08,0.12,0.92,0.50),"围巾": (0.18,0.28,0.82,0.58), "领": (0.18,0.28,0.82,0.58),"衣": (0.10,0.28,0.90,0.76),"上衣": (0.10,0.25,0.90,0.70),"裤": (0.16,0.52,0.84,0.96), "裙": (0.12,0.45,0.88,0.96),"鞋": (0.10,0.72,0.90,1.00),"脚": (0.10,0.70,0.90,1.00),"手套": (0.00,0.35,1.00,0.78), "手": (0.00,0.30,1.00,0.82), "包": (0.00,0.30,1.00,0.86),}
COLOR_HINTS={"红": "red","橙": "orange","黄": "yellow","绿": "green","青": "cyan","蓝": "blue","紫": "purple","粉": "pink","白": "white","黑": "black","灰": "gray","棕": "brown","褐": "brown","red": "red","orange": "orange","yellow": "yellow", "green": "green","cyan": "cyan","blue": "blue","purple": "purple", "pink": "pink","white": "white","black": "black","gray": "gray", "grey": "gray", "brown": "brown",}
SAM3_TARGET_FALLBACKS={"人": "person","人类": "person","人物": "person","人像": "person","真人": "person","主角": "person","角色": "person","模特": "person","背景": "background","场景": "scene","环境": "environment","天空": "sky","地面": "ground","墙": "wall","墙壁": "wall","男人": "man","男士": "man","男性": "man","男孩": "boy","女人": "woman","女士": "woman","女性": "woman","女孩": "girl","帽": "hat","帽子": "hat","眼镜": "glasses","镜": "glasses","衣": "clothes","衣服": "clothes","服装": "clothing","服饰": "clothing","穿着": "clothing", "穿搭": "outfit","套装": "outfit","上衣": "shirt","裤": "pants","裤子": "pants","裙": "skirt","裙子": "skirt","鞋": "shoes","鞋子": "shoes","袜": "socks","袜子": "socks","摇裤儿": "panties","摇裤": "panties","窑裤": "panties","手套": "gloves","耳环": "earrings", "围巾": "scarf","包": "bag","蛋糕": "cake","内裤": "panties", "胸罩": "bra","奶罩": "bra","文胸": "bra","胸衣": "bra", "内衣": "underwear","泳衣": "swimsuit", "领带": "necktie",}
SAM3_NAME_TO_PERSON_RE = re.compile(r"^[\u4e00-\u9fff]{2,4}$")

@dataclass
class SegmentInstruction:
	image_index: int
	targets: list[str] = field(default_factory=list)
	whole_image: bool = False
	source: str = ""


def _send_status(unique_id: Any, text: str) -> None:
	if not unique_id:return
	try:
		from server import PromptServer
		PromptServer.instance.send_sync("gjj_node_progress", {"node": str(unique_id), "text": str(text or "")})
	except Exception:
		pass

def _warning(lines: list[str], text: str) -> None:
	clean = str(text or "").strip()
	if clean:lines.append(f"⚠ {clean}")

def _contains_cjk(text: str) -> bool:
	return bool(re.search(r"[\u4e00-\u9fff]", str(text or "")))


def _looks_like_sam3_prompt(text: str) -> bool:
	value = str(text or "").strip()
	if not value or _contains_cjk(value):return False
	return bool(re.search(r"[A-Za-z0-9]", value))


def _fallback_target_alias(source: str) -> tuple[str, str | None]:
	source = str(source or "").strip()
	if not source:return source, None
	exact = SAM3_TARGET_FALLBACKS.get(source)
	if exact:
		return exact, None

	contained: list[tuple[int, str, str]] = []
	for key, value in SAM3_TARGET_FALLBACKS.items():
		if key and key in source:
			contained.append((len(key), key, value))
	if contained:
		contained.sort(key=lambda item: (-item[0], item[1]))
		_, key, value = contained[0]
		return value, None

	if SAM3_NAME_TO_PERSON_RE.fullmatch(source):
		return "person", None
	return source, None


def _translate_target_to_english(target: str) -> tuple[str, str | None]:
	source = str(target or "").strip()
	if not source:
		return source, None
	if not _contains_cjk(source):
		return source, None

	exact_fallback = SAM3_TARGET_FALLBACKS.get(source)
	if exact_fallback:
		return exact_fallback, None

	try:
		translated = translate_to_english(source, default="")
		if not _looks_like_sam3_prompt(translated):
			translated = translate_text_to_english(source)
	except Exception as exc:
		fallback, fallback_note = _fallback_target_alias(source)
		if fallback != source:
			note = fallback_note or f"目标“{source}”TSV 翻译失败，已用内置兜底词“{fallback}”。"
			return fallback, f"{note} TSV 错误：{exc}"
		return source, f"目标“{source}”TSV 翻译失败，已回退原词；{exc}"

	translated = str(translated or "").strip()
	if _looks_like_sam3_prompt(translated) and translated != source:
		return translated, None

	fallback, fallback_note = _fallback_target_alias(source)
	if fallback != source:
		return fallback, fallback_note
	return source, f"目标“{source}”未在 TSV 中翻译成有效英文，已回退原词。"


def _to_int_chinese(text: str) -> int | None:
	value = str(text or "").strip()
	if not value:
		return None
	if value.isdigit():
		return int(value)
	if value in CN_NUMBERS:
		return CN_NUMBERS[value]
	if value == "十":
		return 10
	if "十" in value:
		left, right = value.split("十", 1)
		tens = CN_NUMBERS.get(left, 1) if left else 1
		ones = CN_NUMBERS.get(right, 0) if right else 0
		return tens * 10 + ones
	total = 0
	for char in value:
		if char not in CN_NUMBERS:
			return None
		total = total * 10 + CN_NUMBERS[char]
	return total


def _find_image_number(text: str) -> tuple[int | None, tuple[int, int] | None]:
	patterns = [
		r"(?:图|图片|image|img)\s*[-_ ]*\s*([+-]?\d+|[零〇一二两三四五六七八九十]+)",
		r"第\s*([+-]?\d+|[零〇一二两三四五六七八九十]+)\s*张(?:图|图片)?",
	]
	for pattern in patterns:
		match = re.search(pattern, text, flags=re.IGNORECASE)
		if not match:
			continue
		number = _to_int_chinese(match.group(1))
		return number, match.span()
	return None, None


def _clean_targets(raw: str) -> list[str]:
	text = str(raw or "").strip()
	text = re.sub(r"^[：:；;,\s_\-—中的里里面第张图图片imageimg]+", "", text, flags=re.IGNORECASE)
	text = re.sub(r"(中的|里的|里面的|中|里|里面)", " ", text)
	text = re.sub(r"[。.!！?？()\[\]{}<>《》\"'“”‘’]", " ", text)
	parts = [part.strip(" _-—:：") for part in TARGET_SPLIT_RE.split(text)]
	targets: list[str] = []
	for part in parts:
		clean = re.sub(r"\s+", "", part)
		clean = re.sub(r"^(的|把|将|要|找|寻找|识别|分割|裁剪|保留)+", "", clean)
		clean = re.sub(r"(分割|裁剪|保留|识别|区域|目标|物体|对象)+$", "", clean)
		if not clean or clean in STOPWORDS:
			continue
		if re.fullmatch(r"(图|图片|image|img|第|张|\d+)+", clean, flags=re.IGNORECASE):
			continue
		targets.append(clean)
	deduped: list[str] = []
	for target in targets:
		if target not in deduped:deduped.append(target)
	return deduped


def _parse_prompt(prompt: str, image_count: int) -> tuple[dict[int, SegmentInstruction], list[str]]:
	warnings: list[str] = []
	instructions: dict[int, SegmentInstruction] = {}
	text = str(prompt or "")
	parts = re.split(r"[;；]+", text)
	sequential_index = 1
	valid_segment_count = 0

	for raw_part in parts:
		part = raw_part.strip()
		if not part:
			_warning(warnings, "检测到空分段，已跳过。")
			continue
		valid_segment_count += 1
		number, span = _find_image_number(part)
		if number is None:
			number = sequential_index
			sequential_index += 1
			target_text = part
		else:
			target_text = (part[: span[0]] + " " + part[span[1] :]) if span else part

		if number is None or number <= 0:
			_warning(warnings, f"无效图片序号：{part}")
			continue
		if number > image_count:
			_warning(warnings, f"图片序号 {number} 超出输入批量总数 {image_count}，已跳过。")
			continue

		targets = _clean_targets(target_text)
		whole_image = len(targets) == 0
		entry = instructions.get(number)
		if entry is None:
			entry = SegmentInstruction(image_index=number, source=part)
			instructions[number] = entry
		entry.whole_image = entry.whole_image or whole_image
		for target in targets:
			if target not in entry.targets:
				entry.targets.append(target)

	if valid_segment_count == 0:
		_warning(warnings, "提示词为空或只有分号，没有有效分割指令。")
	for image_index in range(1, image_count + 1):
		if image_index not in instructions:
			_warning(warnings, f"第 {image_index} 张图片没有匹配指令，已空置不处理。")
	return instructions, warnings


def _ensure_rgba_batch(image: torch.Tensor) -> torch.Tensor:
	if not isinstance(image, torch.Tensor):
		return torch.zeros((1, 64, 64, 4), dtype=torch.float32)
	value = image.detach().float().cpu()
	if value.ndim == 3:
		value = value.unsqueeze(0)
	if value.ndim != 4:
		return torch.zeros((1, 64, 64, 4), dtype=torch.float32)
	channels = int(value.shape[-1])
	if channels == 1:
		rgb = value.repeat(1, 1, 1, 3)
		alpha = torch.ones((*value.shape[:3], 1), dtype=value.dtype)
	elif channels == 2:
		rgb = value[..., :1].repeat(1, 1, 1, 3)
		alpha = value[..., 1:2]
	elif channels == 3:
		rgb = value[..., :3]
		alpha = torch.ones((*value.shape[:3], 1), dtype=value.dtype)
	else:
		rgb = value[..., :3]
		alpha = value[..., 3:4]
	return torch.cat([rgb.clamp(0.0, 1.0), alpha.clamp(0.0, 1.0)], dim=-1).contiguous()


def _box_mask(height: int, width: int, box: tuple[float, float, float, float]) -> torch.Tensor:
	x1 = max(0, min(width - 1, int(round(box[0] * width))))
	y1 = max(0, min(height - 1, int(round(box[1] * height))))
	x2 = max(x1 + 1, min(width, int(round(box[2] * width))))
	y2 = max(y1 + 1, min(height, int(round(box[3] * height))))
	mask = torch.zeros((height, width), dtype=torch.bool)
	mask[y1:y2, x1:x2] = True
	return mask


def _color_mask(rgb: torch.Tensor, color: str) -> torch.Tensor:
	r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
	maxc = torch.max(rgb, dim=-1).values
	minc = torch.min(rgb, dim=-1).values
	sat = maxc - minc
	if color == "red":
		return (r > g + 0.12) & (r > b + 0.12) & (r > 0.28)
	if color == "orange":
		return (r > 0.35) & (g > 0.18) & (r > b + 0.12) & (g > b + 0.05)
	if color == "yellow":
		return (r > 0.45) & (g > 0.42) & (b < 0.40)
	if color == "green":
		return (g > r + 0.10) & (g > b + 0.10) & (g > 0.25)
	if color == "cyan":
		return (g > 0.35) & (b > 0.35) & (r < 0.38)
	if color == "blue":
		return (b > r + 0.10) & (b > g + 0.08) & (b > 0.25)
	if color == "purple":
		return (r > 0.25) & (b > 0.25) & (g < torch.maximum(r, b) - 0.08)
	if color == "pink":
		return (r > 0.45) & (b > 0.25) & (g < r - 0.08)
	if color == "white":
		return (minc > 0.72) & (sat < 0.18)
	if color == "black":
		return maxc < 0.22
	if color == "gray":
		return (maxc > 0.18) & (maxc < 0.78) & (sat < 0.12)
	if color == "brown":
		return (r > g * 0.95) & (g > b + 0.05) & (r > 0.18) & (r < 0.70)
	return torch.zeros(rgb.shape[:2], dtype=torch.bool)


def _salient_mask(rgba: torch.Tensor) -> torch.Tensor:
	rgb = rgba[..., :3]
	alpha = rgba[..., 3]
	if torch.any(alpha < 0.98):
		return alpha > 0.05
	height, width = rgb.shape[:2]
	corner = max(2, min(height, width, max(4, min(height, width) // 12)))
	samples = torch.cat(
		[
			rgb[:corner, :corner].reshape(-1, 3),
			rgb[:corner, -corner:].reshape(-1, 3),
			rgb[-corner:, :corner].reshape(-1, 3),
			rgb[-corner:, -corner:].reshape(-1, 3),
		],
		dim=0,
	)
	bg = samples.median(dim=0).values
	color_distance = torch.linalg.vector_norm(rgb - bg, dim=-1)
	maxc = torch.max(rgb, dim=-1).values
	minc = torch.min(rgb, dim=-1).values
	saturation = maxc - minc
	mask = (color_distance > 0.16) | ((saturation > 0.18) & (color_distance > 0.08))
	return _smooth_binary(mask.float(), 2) > 0.25


def _smooth_binary(mask: torch.Tensor, passes: int = 1) -> torch.Tensor:
	value = mask.float().unsqueeze(0).unsqueeze(0)
	for _ in range(max(0, int(passes))):
		value = F.max_pool2d(value, 3, stride=1, padding=1)
		value = F.avg_pool2d(value, 3, stride=1, padding=1)
	return value.squeeze(0).squeeze(0)


def _largest_bbox(mask: torch.Tensor) -> tuple[int, int, int, int] | None:
	coords = torch.nonzero(mask, as_tuple=False)
	if coords.numel() == 0:
		return None
	y1 = int(coords[:, 0].min().item())
	y2 = int(coords[:, 0].max().item()) + 1
	x1 = int(coords[:, 1].min().item())
	x2 = int(coords[:, 1].max().item()) + 1
	return x1, y1, x2, y2


def _target_mask(rgba: torch.Tensor, target: str) -> tuple[torch.Tensor | None, str | None]:
	target_text = str(target or "").lower()
	rgb = rgba[..., :3]
	height, width = rgb.shape[:2]
	salient = _salient_mask(rgba)
	color = None
	for key, value in COLOR_HINTS.items():
		if key.lower() in target_text:
			color = value
			break
	base: torch.Tensor | None = None
	if color:
		base = _color_mask(rgb, color)

	hint_box = None
	for key, box in sorted(POSITION_HINTS.items(), key=lambda item: len(item[0]), reverse=True):
		if key.lower() in target_text:
			hint_box = box
			break

	if hint_box is not None:
		region = _box_mask(height, width, hint_box)
		if base is not None and torch.count_nonzero(base & region).item() >= 8:
			mask = base & region
		else:
			mask = salient & region
		if torch.count_nonzero(mask).item() < max(8, height * width * 0.0005):
			mask = region if base is None else (base | region) & region
		return _smooth_binary(mask.float(), 2) > 0.18, None

	if base is not None and torch.count_nonzero(base).item() >= 8:
		return _smooth_binary(base.float(), 2) > 0.18, None

	return None, f"无法用纯本地规则识别目标“{target}”，已跳过。"


def _crop_rgba_with_mask(rgba: torch.Tensor, mask: torch.Tensor) -> torch.Tensor | None:
	bbox = _largest_bbox(mask)
	if bbox is None:
		return None
	x1, y1, x2, y2 = bbox
	cropped = rgba[y1:y2, x1:x2, :4].clone()
	alpha = (mask[y1:y2, x1:x2].float() * cropped[..., 3]).clamp(0.0, 1.0)
	cropped[..., 3] = alpha
	cropped[..., :3] = cropped[..., :3] * alpha.unsqueeze(-1)
	return cropped.unsqueeze(0).contiguous()


def _whole_rgba_crop(rgba: torch.Tensor) -> torch.Tensor:
	out = rgba.clone()
	out[..., :3] = out[..., :3] * out[..., 3:4]
	return out.unsqueeze(0).contiguous()


def _sam3_target_mask(processor: Any, rgba: torch.Tensor, target: str, max_detections: int) -> torch.Tensor | None:
	rgb_image = rgba[..., :3].unsqueeze(0).contiguous()
	pil_image = comfy_image_to_pil(rgb_image)
	height, width = int(rgba.shape[0]), int(rgba.shape[1])
	state = processor.set_image(pil_image)
	state = processor.set_text_prompt(str(target or "").strip(), state)
	masks = state.get("masks", None)
	scores = state.get("scores", None)
	if masks is None or len(masks) == 0:
		del state
		return None
	if not isinstance(masks, torch.Tensor):
		masks = torch.as_tensor(masks)

	if scores is not None and len(scores) > 0:
		if not isinstance(scores, torch.Tensor):
			scores = torch.as_tensor(scores)
		sorted_indices = torch.argsort(scores, descending=True)
		masks = masks[sorted_indices]
		scores = scores[sorted_indices]

	if max_detections > 0 and len(masks) > max_detections:
		masks = masks[:max_detections]

	masks = masks_to_comfy_mask(masks).float()
	if masks.ndim == 2:
		masks = masks.unsqueeze(0)
	if masks.ndim == 4 and masks.shape[1] == 1:
		masks = masks.squeeze(1)
	if masks.shape[-2:] != (height, width):
		masks = F.interpolate(masks.unsqueeze(1), size=(height, width), mode="nearest").squeeze(1)
	combined = torch.any(masks > 0.5, dim=0)
	del state
	return combined.cpu()


def _build_rgba_batch(images: list[torch.Tensor], canvas_mode: str = "紧凑裁剪") -> torch.Tensor:
	if not images:
		return torch.zeros((1, 64, 64, 4), dtype=torch.float32)
	max_height = max(int(image.shape[1]) for image in images)
	max_width = max(int(image.shape[2]) for image in images)
	center = str(canvas_mode or "").strip() == "居中补齐"
	padded: list[torch.Tensor] = []
	for image in images:
		image = _ensure_rgba_batch(image)
		height, width = int(image.shape[1]), int(image.shape[2])
		if height == max_height and width == max_width:
			padded.append(image.contiguous())
			continue
		canvas = torch.zeros((1, max_height, max_width, 4), dtype=image.dtype)
		top = max(0, (max_height - height) // 2) if center else 0
		left = max(0, (max_width - width) // 2) if center else 0
		canvas[:, top : top + height, left : left + width, :] = image
		padded.append(canvas)
	return torch.cat(padded, dim=0).contiguous()


class GJJ_BatchTextSegmenter:
	CATEGORY = "GJJ"
	FUNCTION = "segment"
	DESCRIPTION = "GJJ 零依赖批量 SAM3 文本分割器：输入 GJJ_BATCH_IMAGE 和分号分段文本，按图文序号或顺序匹配图片，调用本地 models/sam3 模型输出 RGBA 透明裁剪批量图。无联网、无第三方自定义节点依赖；无法识别时只在面板显示警告并跳过。"
	SEARCH_ALIASES = ["批量文本分割", "SAM3批量文本分割", "文本分割器", "零依赖分割", "RGBA裁剪", "semantic crop", "text segmenter"]
	RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,)
	RETURN_NAMES = ("RGBA批量裁剪图",)
	OUTPUT_TOOLTIPS = ("按文本规则裁剪出的透明 RGBA 批量图片；需要查看单张结果时接 GJJ 批量图片预览/解包节点。",)

	@classmethod
	def INPUT_TYPES(cls):
		available_models = list_sam3_models()
		default_model = pick_available_name(DEFAULT_SAM3_MODEL, available_models, "") or (
			available_models[0] if available_models else DEFAULT_SAM3_MODEL
		)
		return {
			"required": {
				"image": (
					GJJ_BATCH_IMAGE_TYPE,
					{
						"display_name": "批量图片",
						"tooltip": "接入 GJJ 批量图片。RGB、RGBA、灰度都会自动兼容为 RGBA 内部处理。",
					},
				),
				"text_prompt": (
					"STRING",
					{
						"default": DEFAULT_PROMPT,
						"multiline": True,
						"display_name": "批量文本提示",
						"tooltip": "用中文分号；或英文分号;分割。可写图1、image2、第3张等序号；无序号时按分段顺序匹配图片。",
					},
				),
				"sam3_model": (
					available_models or [DEFAULT_SAM3_MODEL],
					{
						"default": default_model,
						"display_name": "SAM3 模型",
						"tooltip": "自动搜索 models/sam3 及其子目录；按去扩展名最长本地模糊匹配。匹配不到时只在面板警告需要的完整相对路径。已有 GJJ SAM3 文本分割器可用的模型可直接复用。",
					},
				),
				"precision": (
					["auto", "bf16", "fp16", "fp32"],
					{
						"default": "auto",
						"display_name": "精度",
						"tooltip": "SAM3 推理精度。auto 会按当前设备自动选择。",
					},
				),
				"confidence_threshold": (
					"FLOAT",
					{
						"default": 0.2,
						"min": 0.0,
						"max": 1.0,
						"step": 0.01,
						"display_name": "置信度阈值",
						"tooltip": "传给 SAM3 文本检测的置信度阈值。",
					},
				),
				"max_detections": (
					"INT",
					{
						"default": -1,
						"min": -1,
						"max": 1024,
						"step": 1,
						"display_name": "最大检测数",
						"tooltip": "-1 表示保留所有检测；大于 0 时只合并得分最高的指定数量遮罩。",
					},
				),
				"canvas_mode": (
					["紧凑裁剪", "居中补齐"],
					{
						"default": "紧凑裁剪",
						"display_name": "裁剪画布",
						"tooltip": "GJJ_BATCH_IMAGE 同批必须同宽高。紧凑裁剪会先按遮罩裁剪，再贴左上角补透明边到批量最大裁剪尺寸；居中补齐会把裁剪结果居中放入统一透明画布。",
					},
				),
				"warning_panel": (
					"STRING",
					{
						"default": DEFAULT_WARNING,
						"multiline": True,
						"display_name": "⚠ 警告面板",
						"tooltip": "前端显示最近一次解析/匹配警告；执行时由节点自动更新。",
					},
				),
			},
			"hidden": {"unique_id": "UNIQUE_ID"},
		}

	def segment(
		self,
		image,
		text_prompt,
		sam3_model=DEFAULT_SAM3_MODEL,
		precision="auto",
		confidence_threshold=0.2,
		max_detections=-1,
		canvas_mode="紧凑裁剪",
		warning_panel=DEFAULT_WARNING,
		unique_id=None,
	):
		warnings: list[str] = []
		outputs: list[torch.Tensor] = []
		try:
			batch = _ensure_rgba_batch(image)
			image_count = int(batch.shape[0])
			instructions, parse_warnings = _parse_prompt(text_prompt, image_count)
			warnings.extend(parse_warnings)
			_send_status(unique_id, f"解析完成：{len(instructions)} 张待处理，{len(warnings)} 条警告。")

			sam3 = None
			processor = None
			needs_sam3 = any(item.targets for item in instructions.values())
			if needs_sam3:
				available = list_sam3_models()
				resolved_model = pick_available_name(str(sam3_model or DEFAULT_SAM3_MODEL), available, DEFAULT_SAM3_MODEL)
				if not resolved_model:
					requested = str(sam3_model or DEFAULT_SAM3_MODEL).strip() or DEFAULT_SAM3_MODEL
					_warning(warnings, f"未匹配到 SAM3 模型，需要文件：models/sam3/{requested}")
					status = "\n".join(warnings[-20:])
					_send_status(unique_id, status)
					return {"ui": {"warning_text": [status]}, "result": (_build_rgba_batch(outputs, canvas_mode),)}
				try:
					import comfy.model_management

					_send_status(unique_id, f"加载 SAM3 模型：{resolved_model}")
					sam3 = get_or_build_model(resolved_model, precision=precision, compile_model=False)
					comfy.model_management.load_models_gpu([sam3])
					processor = sam3.processor
					if hasattr(processor, "sync_device_with_model"):
						processor.sync_device_with_model()
					if hasattr(processor, "set_confidence_threshold"):
						processor.set_confidence_threshold(float(confidence_threshold))
				except Exception as exc:
					_warning(warnings, f"SAM3 模型加载失败，需要文件：models/sam3/{resolved_model}；详细信息：{exc}")
					status = "\n".join(warnings[-20:])
					_send_status(unique_id, status)
					return {"ui": {"warning_text": [status]}, "result": (_build_rgba_batch(outputs, canvas_mode),)}

			for image_number in sorted(instructions.keys()):
				instruction = instructions[image_number]
				rgba = batch[image_number - 1]
				if instruction.whole_image and not instruction.targets:
					outputs.append(_whole_rgba_crop(rgba))
					continue

				combined = torch.zeros(tuple(rgba.shape[:2]), dtype=torch.bool)
				for target in instruction.targets:
					if processor is None:
						_warning(warnings, f"第 {image_number} 张：SAM3 未加载，目标“{target}”已跳过。")
						continue
					sam3_prompt, translate_warning = _translate_target_to_english(target)
					if translate_warning:
						_warning(warnings, f"第 {image_number} 张：{translate_warning}")
					try:
						target_mask = _sam3_target_mask(processor, rgba, sam3_prompt, int(max_detections))
					except Exception as exc:
						_warning(warnings, f"第 {image_number} 张：目标“{target}”翻译为“{sam3_prompt}”后 SAM3 分割失败，已跳过；{exc}")
						continue
					if target_mask is None or torch.count_nonzero(target_mask).item() == 0:
						_warning(warnings, f"第 {image_number} 张：目标“{target}”翻译为“{sam3_prompt}”后没有找到有效区域，已跳过。")
						continue
					combined |= target_mask

				if torch.count_nonzero(combined).item() == 0:
					_warning(warnings, f"第 {image_number} 张没有可输出的有效分割区域，已跳过。")
					continue
				cropped = _crop_rgba_with_mask(rgba, combined)
				if cropped is None:
					_warning(warnings, f"第 {image_number} 张裁剪区域为空，已跳过。")
					continue
				outputs.append(cropped)

			if not outputs:
				_warning(warnings, "没有生成有效裁剪结果；为保持后续流程不中断，输出 64x64 透明占位批量图。")
			elif len(outputs) > 1:
				_warning(warnings, "GJJ_BATCH_IMAGE 同批必须统一宽高；已按裁剪结果的批量最大尺寸补透明边输出。")
			status = "\n".join(warnings[-20:]) if warnings else f"完成：输出 {len(outputs)} 张 RGBA 裁剪图。"
			_send_status(unique_id, status)
			gc.collect()
			return {"ui": {"warning_text": [status]}, "result": (_build_rgba_batch(outputs, canvas_mode),)}
		except Exception as exc:
			_warning(warnings, f"内部异常已拦截：{exc}")
			status = "\n".join(warnings[-20:])
			_send_status(unique_id, status)
			return {"ui": {"warning_text": [status]}, "result": (_build_rgba_batch(outputs, canvas_mode),)}

NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_BatchTextSegmenter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ·✂️批量文本分割器抠图(SAM3)"}

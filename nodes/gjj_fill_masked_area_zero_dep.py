from __future__ import annotations

import torch
import torch.nn.functional as F


def _normalize_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise ValueError("图片输入必须是 IMAGE。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError(f"图片维度不正确，应为 IMAGE，实际为：{tuple(image.shape)}")
    return image.float().clamp(0.0, 1.0).contiguous()


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise ValueError("遮罩输入必须是 MASK。")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4 and int(mask.shape[-1]) == 1:
        mask = mask[..., 0]
    elif mask.ndim == 4 and int(mask.shape[1]) == 1:
        mask = mask[:, 0]
    if mask.ndim != 3:
        raise ValueError(f"遮罩维度不正确，应为 MASK，实际为：{tuple(mask.shape)}")
    return mask.float().clamp(0.0, 1.0).contiguous()


def _match_batch(image: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    image_batch = int(image.shape[0])
    mask_batch = int(mask.shape[0])
    if image_batch == mask_batch:
        return image, mask
    if mask_batch == 1:
        return image, mask.repeat(image_batch, 1, 1)
    if image_batch == 1:
        return image.repeat(mask_batch, 1, 1, 1), mask
    raise ValueError(f"图片和遮罩批次数不一致：{image_batch} != {mask_batch}")


def _resize_mask_to_image(mask: torch.Tensor, image: torch.Tensor) -> torch.Tensor:
    target_h = int(image.shape[1])
    target_w = int(image.shape[2])
    if int(mask.shape[-2]) == target_h and int(mask.shape[-1]) == target_w:
        return mask
    resized = F.interpolate(
        mask.unsqueeze(1),
        size=(target_h, target_w),
        mode="nearest-exact",
    )
    return resized[:, 0].contiguous()


def _fill_holes_single(mask_2d: torch.Tensor) -> torch.Tensor:
    binary = mask_2d > 0.0
    if binary.numel() == 0 or not bool(binary.any()):
        return binary.to(mask_2d.dtype)

    background = ~binary
    reachable = torch.zeros_like(background)
    reachable[0, :] = background[0, :]
    reachable[-1, :] = background[-1, :]
    reachable[:, 0] |= background[:, 0]
    reachable[:, -1] |= background[:, -1]

    max_steps = int(mask_2d.shape[-2]) + int(mask_2d.shape[-1])
    for _ in range(max_steps):
        expanded = F.max_pool2d(
            reachable.float().unsqueeze(0).unsqueeze(0),
            kernel_size=3,
            stride=1,
            padding=1,
        )[0, 0] > 0.0
        next_reachable = expanded & background
        if torch.equal(next_reachable, reachable):
            break
        reachable = next_reachable

    filled = binary | (background & ~reachable)
    return filled.to(mask_2d.dtype)


def _fill_holes(mask: torch.Tensor) -> torch.Tensor:
    return torch.stack([_fill_holes_single(item) for item in mask], dim=0).contiguous()


class GJJ_FillMaskHolesAndMaskedArea:
    CATEGORY = "GJJ/图像"
    FUNCTION = "fill"
    DESCRIPTION = "零依赖单节点：先填充遮罩内部闭合空洞，再按 neutral 方式填充图片中的遮罩区域。"
    SEARCH_ALIASES = [
        "Fill Masked Area",
        "Mask Fill Holes",
        "masked fill",
        "fill mask holes",
        "遮罩填洞",
        "填充遮罩区域",
    ]

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    OUTPUT_TOOLTIPS = ("遮罩填洞后，将遮罩区域填充为 neutral 基准的图像。",)

    GJJ_HELP = {
        "title": "遮罩填洞并填充图像",
        "description": "把 WAS/Meux 的 Mask Fill Holes 与 Fill Masked Area(neutral, falloff=0) 合并为一个零依赖节点。",
        "usage": [
            "连接 image 和 mask 即可输出已填充遮罩区域的图像。",
            "遮罩中任何大于 0 的像素都会参与填洞，输出填充区域为二值遮罩。",
        ],
        "notes": [
            "不依赖 WAS Node Suite、comfyui-inpaint-nodes、scipy 或 cv2。",
            "如果单张遮罩连接到图片批次，会自动复用到每张图片。",
        ],
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"display_name": "图片", "tooltip": "需要填充遮罩区域的图片。"}),
                "mask": ("MASK", {"display_name": "遮罩", "tooltip": "输入遮罩；节点会先填充内部闭合空洞。"}),
            }
        }

    def fill(self, image: torch.Tensor, mask: torch.Tensor):
        image = _normalize_image(image).clone()
        mask = _normalize_mask(mask).to(device=image.device, dtype=image.dtype)
        image, mask = _match_batch(image, mask)
        mask = _resize_mask_to_image(mask, image)
        alpha = _fill_holes(mask).to(device=image.device, dtype=image.dtype)

        keep = (1.0 - alpha).unsqueeze(-1)
        channels = min(3, int(image.shape[-1]))
        image[..., :channels] = (image[..., :channels] - 0.5) * keep + 0.5
        return (image.clamp(0.0, 1.0),)


NODE_CLASS_MAPPINGS = {
    "GJJ_FillMaskHolesAndMaskedArea": GJJ_FillMaskHolesAndMaskedArea,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_FillMaskHolesAndMaskedArea": "遮罩填洞并填充图像",
}

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter


if not hasattr(Image, "Resampling"):
    Image.Resampling = Image


BLUR_KERNEL_SIZE = 15


def tensor_to_pil(img_tensor, batch_index: int = 0) -> Image.Image:
    safe_tensor = torch.nan_to_num(img_tensor[batch_index])
    return Image.fromarray((255 * safe_tensor.cpu().numpy()).astype(np.uint8))


def pil_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.array(image).astype(np.float32) / 255.0
    tensor = torch.from_numpy(array).unsqueeze(0)
    if len(tensor.shape) == 3:
        tensor = tensor.unsqueeze(-1)
    return tensor


def crop_tensor(tensor: torch.Tensor, region: tuple[int, int, int, int]) -> torch.Tensor:
    x1, y1, x2, y2 = region
    return tensor[:, y1:y2, x1:x2, :]


def resize_tensor(tensor: torch.Tensor, size: tuple[int, int], mode: str = "nearest-exact") -> torch.Tensor:
    return F.interpolate(tensor, size=size, mode=mode)


def get_crop_region(mask: Image.Image, pad: int = 0) -> tuple[int, int, int, int]:
    coordinates = mask.getbbox()
    if coordinates is not None:
        x1, y1, x2, y2 = coordinates
    else:
        x1, y1, x2, y2 = mask.width, mask.height, 0, 0

    x1 = max(x1 - pad, 0)
    y1 = max(y1 - pad, 0)
    x2 = min(x2 + pad, mask.width)
    y2 = min(y2 + pad, mask.height)
    return fix_crop_region((x1, y1, x2, y2), (mask.width, mask.height))


def fix_crop_region(region: tuple[int, int, int, int], image_size: tuple[int, int]) -> tuple[int, int, int, int]:
    image_width, image_height = image_size
    x1, y1, x2, y2 = region
    if x2 < image_width:
        x2 -= 1
    if y2 < image_height:
        y2 -= 1
    return x1, y1, x2, y2


def expand_crop(
    region: tuple[int, int, int, int],
    width: int,
    height: int,
    target_width: int,
    target_height: int,
) -> tuple[tuple[int, int, int, int], tuple[int, int]]:
    x1, y1, x2, y2 = region
    actual_width = x2 - x1
    actual_height = y2 - y1

    width_diff = target_width - actual_width
    x2 = min(x2 + width_diff // 2, width)
    width_diff = target_width - (x2 - x1)
    x1 = max(x1 - width_diff, 0)
    width_diff = target_width - (x2 - x1)
    x2 = min(x2 + width_diff, width)

    height_diff = target_height - actual_height
    y2 = min(y2 + height_diff // 2, height)
    height_diff = target_height - (y2 - y1)
    y1 = max(y1 - height_diff, 0)
    height_diff = target_height - (y2 - y1)
    y2 = min(y2 + height_diff, height)

    return (x1, y1, x2, y2), (target_width, target_height)


def resize_region(
    region: tuple[int, int, int, int],
    init_size: tuple[int, int],
    resize_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = region
    init_width, init_height = init_size
    resize_width, resize_height = resize_size
    x1 = math.floor(x1 * resize_width / init_width)
    x2 = math.ceil(x2 * resize_width / init_width)
    y1 = math.floor(y1 * resize_height / init_height)
    y2 = math.ceil(y2 * resize_height / init_height)
    return (x1, y1, x2, y2)


def region_intersection(
    region1: tuple[int, int, int, int],
    region2: tuple[int, int, int, int],
) -> tuple[int, int, int, int] | None:
    x1, y1, x2, y2 = region1
    x1_, y1_, x2_, y2_ = region2
    x1 = max(x1, x1_)
    y1 = max(y1, y1_)
    x2 = min(x2, x2_)
    y2 = min(y2, y2_)
    if x1 >= x2 or y1 >= y2:
        return None
    return (x1, y1, x2, y2)


def crop_controlnet(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad):
    if "control" not in cond_dict:
        return

    if not isinstance(regions, list):
        regions = [regions]

    controlnet = cond_dict["control"].copy()
    cond_dict["control"] = controlnet
    current = controlnet

    while current is not None:
        hint = controlnet.cond_hint_original
        tiled_hints = []
        for region in regions:
            resized_crop = resize_region(region, canvas_size, hint.shape[:-3:-1])
            tiled_hint = crop_tensor(hint.movedim(1, -1), resized_crop).movedim(-1, 1)
            tiled_hint = resize_tensor(tiled_hint, tile_size[::-1])
            tiled_hints.append(tiled_hint)
        controlnet.cond_hint_original = torch.cat(tiled_hints, dim=0)
        current = current.previous_controlnet
        controlnet.set_previous_controlnet(current.copy() if current is not None else None)
        controlnet = controlnet.previous_controlnet


def crop_gligen(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad):
    if "gligen" not in cond_dict:
        return

    region = regions if isinstance(regions, tuple) else regions[0]
    type_name, model, cond = cond_dict["gligen"]
    if type_name != "position":
        return

    cropped = []
    for emb, h, w, y, x in cond:
        x1 = x * 8
        y1 = y * 8
        x2 = x1 + w * 8
        y2 = y1 + h * 8
        gligen_upscaled_box = resize_region((x1, y1, x2, y2), init_size, canvas_size)
        intersection = region_intersection(gligen_upscaled_box, region)
        if intersection is None:
            continue

        x1, y1, x2, y2 = intersection
        x1 -= region[0]
        y1 -= region[1]
        x2 -= region[0]
        y2 -= region[1]
        x1 += w_pad
        y1 += h_pad
        x2 += w_pad
        y2 += h_pad

        h = (y2 - y1) // 8
        w = (x2 - x1) // 8
        x = x1 // 8
        y = y1 // 8
        cropped.append((emb, h, w, y, x))

    cond_dict["gligen"] = (type_name, model, cropped)


def crop_area(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad):
    if "area" not in cond_dict:
        return

    region = regions if isinstance(regions, tuple) else regions[0]
    h, w, y, x = cond_dict["area"]
    w, h, x, y = 8 * w, 8 * h, 8 * x, 8 * y
    x1, y1, x2, y2 = resize_region((x, y, x + w, y + h), init_size, canvas_size)
    intersection = region_intersection((x1, y1, x2, y2), region)
    if intersection is None:
        del cond_dict["area"]
        if "strength" in cond_dict:
            del cond_dict["strength"]
        return

    x1, y1, x2, y2 = intersection
    x1 -= region[0]
    y1 -= region[1]
    x2 -= region[0]
    y2 -= region[1]
    x1 += w_pad
    y1 += h_pad
    x2 += w_pad
    y2 += h_pad

    w, h = (x2 - x1) // 8, (y2 - y1) // 8
    x, y = x1 // 8, y1 // 8
    cond_dict["area"] = (h, w, y, x)


def crop_mask(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad):
    if "mask" not in cond_dict:
        return

    region = regions if isinstance(regions, tuple) else regions[0]
    mask_tensor = cond_dict["mask"]
    masks = []
    for index in range(mask_tensor.shape[0]):
        mask = tensor_to_pil(mask_tensor, index)
        mask = mask.resize(canvas_size, Image.Resampling.BICUBIC)
        mask = mask.crop(region)
        if tile_size != mask.size:
            mask = mask.resize(tile_size, Image.Resampling.BICUBIC)
        mask = pil_to_tensor(mask).squeeze(-1)
        masks.append(mask)
    cond_dict["mask"] = torch.cat(masks, dim=0)


def crop_reference_latents(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad):
    latents = cond_dict.get("reference_latents")
    if not isinstance(latents, list):
        return

    region = regions if isinstance(regions, tuple) else regions[0]
    k = 8
    canvas_width_px, canvas_height_px = canvas_size
    canvas_width_lat, canvas_height_lat = canvas_width_px // k, canvas_height_px // k
    tile_width_px, tile_height_px = tile_size
    tile_width_lat = max(1, tile_width_px // k)
    tile_height_lat = max(1, tile_height_px // k)
    x1_px, y1_px, x2_px, y2_px = region

    new_latents = []
    for latent in latents:
        has_5d = False
        if latent.ndim == 5:
            has_5d = True
            latent = latent.squeeze(2)
        if latent.ndim != 4:
            raise ValueError(f"expected BCHW, got {latent.shape}")

        if latent.shape[-2:] != (canvas_height_lat, canvas_width_lat):
            latent = F.interpolate(
                latent,
                size=(canvas_height_lat, canvas_width_lat),
                mode="bilinear",
                align_corners=False,
            )

        w0_lat = int(round(x1_px / k))
        w1_lat = int(round(x2_px / k))
        h0_lat = int(round(y1_px / k))
        h1_lat = int(round(y2_px / k))

        cropped = latent[:, :, h0_lat:h1_lat, w0_lat:w1_lat]
        cropped = F.interpolate(
            cropped,
            size=(tile_height_lat, tile_width_lat),
            mode="bilinear",
            align_corners=False,
        )
        if has_5d:
            cropped = cropped.unsqueeze(2)
        new_latents.append(cropped)

    cond_dict["reference_latents"] = new_latents


def crop_cond(cond, regions, init_size, canvas_size, tile_size, w_pad: int = 0, h_pad: int = 0):
    cropped = []
    for emb, item in cond:
        cond_dict = item.copy()
        crop_controlnet(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad)
        crop_gligen(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad)
        crop_area(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad)
        crop_mask(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad)
        crop_reference_latents(cond_dict, regions, init_size, canvas_size, tile_size, w_pad, h_pad)
        cropped.append([emb, cond_dict])
    return cropped

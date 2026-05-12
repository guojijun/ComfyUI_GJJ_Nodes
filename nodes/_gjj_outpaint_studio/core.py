"""GJJ 扩图工具 - 核心功能模块"""

import torch

# ================================================
# 配置解析函数
# ================================================


def _parse_config(config_str: str) -> dict:
    """解析配置字符串。"""
    result = {}
    if not config_str:
        return result

    try:
        for item in config_str.split(","):
            item = item.strip()
            if "=" in item:
                key, value = item.split("=", 1)
                key = key.strip()
                value = value.strip()

                if value.lower() == "true":
                    result[key] = True
                elif value.lower() == "false":
                    result[key] = False
                elif value.isdigit():
                    result[key] = int(value)
                elif "." in value and value.replace(".", "").isdigit():
                    result[key] = float(value)
                else:
                    result[key] = value
    except Exception:
        pass

    return result


# ================================================
# 图像扩展函数
# ================================================


def _expand_by_pixels(
    image: torch.Tensor,
    left: int,
    right: int,
    top: int,
    bottom: int,
) -> torch.Tensor:
    """按像素扩展图像（自定义算法，带边缘羽化）。"""
    batch_size, img_h, img_w, channels = image.shape

    new_w = img_w + left + right
    new_h = img_h + top + bottom

    if left == 0 and right == 0 and top == 0 and bottom == 0:
        return image

    expanded = torch.zeros(
        (batch_size, new_h, new_w, channels), dtype=image.dtype, device=image.device
    )

    expanded[:, top : top + img_h, left : left + img_w, :] = image

    feather_size = (
        min(8, left, right, top, bottom, img_w // 4, img_h // 4)
        if min(left, right, top, bottom) > 0
        else 0
    )

    def feather_edge(src, dst, size, direction):
        if size <= 0:
            return

        for i in range(size):
            t = i / size
            if direction == "left":
                dst[:, top : top + img_h, i, :] = (1 - t) * src[:, :, 0, :] + t * src[
                    :, :, min(i, img_w - 1), :
                ]
            elif direction == "right":
                dst[:, top : top + img_h, new_w - 1 - i, :] = (1 - t) * src[
                    :, :, -1, :
                ] + t * src[:, :, max(img_w - 1 - i, 0), :]
            elif direction == "top":
                dst[:, i, left : left + img_w, :] = (1 - t) * src[:, 0, :, :] + t * src[
                    :, min(i, img_h - 1), :, :
                ]
            elif direction == "bottom":
                dst[:, new_h - 1 - i, left : left + img_w, :] = (1 - t) * src[
                    :, -1, :, :
                ] + t * src[:, max(img_h - 1 - i, 0), :, :]

    if left > 0:
        fill_val = image[:, :, 0, :].unsqueeze(2).repeat(1, 1, left, 1)
        expanded[:, top : top + img_h, :left, :] = fill_val
        feather_edge(image, expanded, feather_size, "left")

    if right > 0:
        fill_val = image[:, :, -1, :].unsqueeze(2).repeat(1, 1, right, 1)
        expanded[:, top : top + img_h, img_w + left :, :] = fill_val
        feather_edge(image, expanded, feather_size, "right")

    if top > 0:
        fill_val = image[:, 0, :, :].unsqueeze(1).repeat(1, top, 1, 1)
        expanded[:top, :, :] = fill_val
        feather_edge(image, expanded, feather_size, "top")

    if bottom > 0:
        fill_val = image[:, -1, :, :].unsqueeze(1).repeat(1, bottom, 1, 1)
        expanded[img_h + top :, :, :] = fill_val
        feather_edge(image, expanded, feather_size, "bottom")

    return expanded


# ================================================
# 尺寸计算函数
# ================================================


def _compute_target_padding_keep_scale(orig_w, orig_h, target_w, target_h, direction):
    """计算保持比例的填充量。"""
    scale_w = target_w / orig_w
    scale_h = target_h / orig_h

    scale = min(scale_w, scale_h)

    scaled_w = int(orig_w * scale)
    scaled_h = int(orig_h * scale)

    padding_w = target_w - scaled_w
    padding_h = target_h - scaled_h

    left = right = top = bottom = 0

    if "left" in direction:
        left = padding_w // 2
    if "right" in direction:
        right = padding_w - left

    if "top" in direction:
        top = padding_h // 2
    if "bottom" in direction:
        bottom = padding_h - top

    return left, right, top, bottom, scaled_w, scaled_h


def _expand_to_target_size(image, target_width, target_height, scale_mode, direction):
    """将图像扩展到目标尺寸。"""
    _, orig_h, orig_w, _ = image.shape

    if scale_mode == "cover":
        scale_w = target_width / orig_w
        scale_h = target_height / orig_h
        scale = max(scale_w, scale_h)

        scaled_w = int(orig_w * scale)
        scaled_h = int(orig_h * scale)

        left = (scaled_w - target_width) // 2
        right = scaled_w - target_width - left
        top = (scaled_h - target_height) // 2
        bottom = scaled_h - target_height - top

        left = max(0, left)
        right = max(0, right)
        top = max(0, top)
        bottom = max(0, bottom)

        new_w = target_width + left + right
        new_h = target_height + top + bottom

        expanded = torch.zeros(
            (1, new_h, new_w, 3), dtype=image.dtype, device=image.device
        )
        expanded[:, top : top + target_height, left : left + target_width, :] = image[
            :, :target_height, :target_width, :
        ]
    else:
        left, right, top, bottom, scaled_w, scaled_h = (
            _compute_target_padding_keep_scale(
                orig_w, orig_h, target_width, target_height, direction
            )
        )

        new_w = orig_w + left + right
        new_h = orig_h + top + bottom

        expanded = torch.zeros(
            (1, new_h, new_w, 3), dtype=image.dtype, device=image.device
        )
        expanded[:, top : top + orig_h, left : left + orig_w, :] = image

    pad_amounts = {
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "orig_w": orig_w,
        "orig_h": orig_h,
    }

    return expanded, pad_amounts


# ================================================
# 模型扫描函数
# ================================================


def _scan_mode_models(mode, OUTPAINT_MODES, model_manager):
    """扫描指定模式的可用模型。"""
    mode_config = OUTPAINT_MODES.get(mode, OUTPAINT_MODES["sd15_inpaint"])
    categories = mode_config.get("model_categories", {})
    available_models = {}

    for cat, keywords in categories.items():
        if isinstance(keywords, str):
            keywords = [keywords]

        matches = []
        for kw in keywords:
            found = model_manager.gjjutils_find_model_list(kw, cat)
            matches.extend(found)

        available_models[cat] = list(set(matches))

    return available_models


def _validate_mode(mode, OUTPAINT_MODES, DOWNLOAD_URL, model_manager):
    """验证模式是否可用（是否有可用模型）。"""
    mode_config = OUTPAINT_MODES.get(mode, OUTPAINT_MODES["sd15_inpaint"])
    available = _scan_mode_models(mode, OUTPAINT_MODES, model_manager)

    for cat in ["checkpoints", "diffusion_models"]:
        if cat in mode_config.get("model_categories", {}) and not available.get(cat):
            return False, f"未找到 {mode} 模式所需的模型，请下载或检查模型路径"

    return True, ""


# ================================================
# 模型加载函数
# ================================================


def _load_mode_models(mode, OUTPAINT_MODES, model_cache, model_manager, _free_vram):
    """加载模式所需的模型。"""
    config = OUTPAINT_MODES.get(mode, OUTPAINT_MODES["sd15_inpaint"])
    categories = config.get("model_categories", {})
    cache_key = f"mode_{mode}"

    if model_cache and next(iter(model_cache.keys())) != cache_key:
        model_cache.clear()
        _free_vram()

    if cache_key in model_cache:
        return model_cache[cache_key]

    models = {}

    import folder_paths

    # --- 主模型（checkpoints 或 diffusion_models）---
    for cat in ["checkpoints", "diffusion_models"]:
        if cat not in categories:
            continue
        kw = categories[cat]
        if isinstance(kw, str):
            kw = [kw]
        best = None
        for keyword in kw:
            matches = model_manager.gjjutils_find_model_list(keyword, cat)
            if matches:
                best = matches[0]
                break
        if best:
            full_path = folder_paths.get_full_path(cat, best)
            if full_path is not None:
                from comfy.sd import load_checkpoint_guess_config

                model_tuple = load_checkpoint_guess_config(
                    full_path,
                    output_vae=True,
                    output_clip=True,
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                )
                models["model"] = model_tuple[0]
                # 只有 checkpoint 类才会同时返回 clip/vae；扩散模型可能返回 None
                models["clip"] = model_tuple[1] if len(model_tuple) > 1 else None
                models["vae"] = model_tuple[2] if len(model_tuple) > 2 else None
                break

    # --- VAE 单独加载（仅当尚未拿到有效 VAE 时） ---
    vae_loaded = models.get("vae") is not None
    if not vae_loaded and ("vae" in categories):
        kw = categories["vae"]
        if isinstance(kw, str):
            kw = [kw]
        best = None
        for keyword in kw:
            matches = model_manager.gjjutils_find_model_list(keyword, "vae")
            if matches:
                best = matches[0]
                break
        if best:
            full_path = folder_paths.get_full_path("vae", best)
            if full_path is not None:
                from comfy.sd import load_vae

                models["vae"] = load_vae(full_path)

    # --- CLIP / Text Encoder 单独加载（仅当尚未拿到有效 CLIP 时） ---
    clip_loaded = models.get("clip") is not None
    if not clip_loaded and ("text_encoders" in categories):
        kw = categories["text_encoders"]
        if isinstance(kw, str):
            kw = [kw]
        best = None
        for keyword in kw:
            matches = model_manager.gjjutils_find_model_list(keyword, "text_encoders")
            if matches:
                best = matches[0]
                break
        if best:
            full_path = folder_paths.get_full_path("text_encoders", best)
            if full_path is not None:
                from comfy.sd import load_clip

                # load_clip 可能返回 clip 对象或 None
                loaded_clip = load_clip(
                    ckpt_paths=[full_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                )
                if loaded_clip is not None:
                    models["clip"] = loaded_clip

    model_cache[cache_key] = models
    return models


__all__ = [
    "_parse_config",
    "_expand_by_pixels",
    "_compute_target_padding_keep_scale",
    "_expand_to_target_size",
    "_scan_mode_models",
    "_validate_mode",
    "_load_mode_models",
]

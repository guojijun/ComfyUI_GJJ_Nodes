from __future__ import annotations

import math
from enum import Enum

from PIL import Image, ImageDraw, ImageFilter, ImageOps
import comfy.utils
import torch
from nodes import VAEEncode, VAEDecode, VAEDecodeTiled, common_ksampler

from .gjj_ultimate_crop_patch import crop_model_cond
from .gjj_ultimate_utils import crop_cond, expand_crop, get_crop_region, pil_to_tensor, tensor_to_pil


if not hasattr(Image, "Resampling"):
    Image.Resampling = Image


class USDUMode(Enum):
    LINEAR = 0
    CHESS = 1
    NONE = 2


class USDUSFMode(Enum):
    NONE = 0
    BAND_PASS = 1
    HALF_TILE = 2
    HALF_TILE_PLUS_INTERSECTIONS = 3


class UltimateSDProcessing:
    def __init__(
        self,
        batch,
        init_size,
        model,
        positive,
        negative,
        vae,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        target_width,
        target_height,
        tile_width,
        tile_height,
        force_uniform_tiles,
        tiled_decode,
        tile_batch_size,
        total_jobs,
    ):
        self.batch = list(batch)
        self.init_size = init_size
        self.model = model
        self.positive = positive
        self.negative = negative
        self.vae = vae
        self.seed = int(seed)
        self.steps = int(steps)
        self.cfg = float(cfg)
        self.sampler_name = sampler_name
        self.scheduler = scheduler
        self.default_denoise = float(denoise)
        self.canvas_width = int(target_width)
        self.canvas_height = int(target_height)
        self.tile_width = int(tile_width)
        self.tile_height = int(tile_height)
        self.force_uniform_tiles = bool(force_uniform_tiles)
        self.tiled_decode = bool(tiled_decode)
        self.tile_batch_size = max(1, int(tile_batch_size))
        self.vae_encoder = VAEEncode()
        self.vae_decoder = VAEDecode()
        self.vae_decoder_tiled = VAEDecodeTiled()
        self.progress = comfy.utils.ProgressBar(max(1, int(total_jobs)))

    def advance(self, value: int = 1) -> None:
        self.progress.update(max(1, int(value)))


def _round_up(value: int, multiple: int = 8) -> int:
    return max(multiple, math.ceil(int(value) / multiple) * multiple)


def _sample(model, p: UltimateSDProcessing, positive, negative, latent, denoise: float):
    return common_ksampler(
        model,
        p.seed,
        p.steps,
        p.cfg,
        p.sampler_name,
        p.scheduler,
        positive,
        negative,
        latent,
        denoise=float(denoise),
    )[0]


def _prepare_tile_for_batch(
    p: UltimateSDProcessing,
    current_image: Image.Image,
    region: tuple[int, int, int, int],
    process_width: int,
    process_height: int,
    padding: int,
    mask_blur: int,
):
    tile_mask = Image.new("L", (current_image.width, current_image.height), "black")
    tile_draw = ImageDraw.Draw(tile_mask)
    tile_draw.rectangle(region, fill="white")

    crop_region = get_crop_region(tile_mask, padding)

    if p.force_uniform_tiles:
        x1, y1, x2, y2 = crop_region
        crop_w = x2 - x1
        crop_h = y2 - y1
        crop_ratio = crop_w / max(crop_h, 1)
        p_ratio = process_width / max(process_height, 1)
        if crop_ratio > p_ratio:
            target_w = crop_w
            target_h = round(crop_w / max(p_ratio, 1e-6))
        else:
            target_w = round(crop_h * p_ratio)
            target_h = crop_h
        crop_region, _ = expand_crop(crop_region, tile_mask.width, tile_mask.height, target_w, target_h)
        tile_size = (process_width, process_height)
    else:
        x1, y1, x2, y2 = crop_region
        crop_w = x2 - x1
        crop_h = y2 - y1
        target_w = _round_up(crop_w, 8)
        target_h = _round_up(crop_h, 8)
        crop_region, tile_size = expand_crop(crop_region, tile_mask.width, tile_mask.height, target_w, target_h)

    if mask_blur > 0:
        tile_mask = tile_mask.filter(ImageFilter.GaussianBlur(mask_blur))

    cropped_tile = current_image.crop(crop_region)
    initial_tile_size = cropped_tile.size
    if cropped_tile.size != tile_size:
        cropped_tile = cropped_tile.resize(tile_size, Image.Resampling.LANCZOS)

    return cropped_tile, initial_tile_size, tile_mask, crop_region, tile_size


def _decode_samples(p: UltimateSDProcessing, samples):
    if p.tiled_decode:
        return p.vae_decoder_tiled.decode(p.vae, samples, 512)[0]
    return p.vae_decoder.decode(p.vae, samples)[0]


def _process_tile_batch(
    p: UltimateSDProcessing,
    regions: list[tuple[int, int, int, int]],
    process_width: int,
    process_height: int,
    padding: int,
    mask_blur: int,
    denoise: float,
) -> None:
    if not regions:
        return

    batch_tiles = []
    batch_masks = []
    batch_crop_regions = []
    batch_tile_sizes = []

    for current_image in p.batch:
        for region in regions:
            tile_data = _prepare_tile_for_batch(
                p,
                current_image,
                region,
                process_width,
                process_height,
                padding,
                mask_blur,
            )
            cropped_tile, initial_tile_size, tile_mask, crop_region, tile_size = tile_data
            batch_tiles.append((cropped_tile, initial_tile_size))
            batch_masks.append(tile_mask)
            batch_crop_regions.append(crop_region)
            batch_tile_sizes.append(tile_size)

    first_tile_size = batch_tile_sizes[0]
    batched_tensors = torch.cat([pil_to_tensor(tile) for tile, _ in batch_tiles], dim=0)
    latent = p.vae_encoder.encode(p.vae, batched_tensors)[0]

    canvas_size = (p.canvas_width, p.canvas_height)
    positive_cropped = crop_cond(p.positive, batch_crop_regions, p.init_size, canvas_size, first_tile_size)
    negative_cropped = crop_cond(p.negative, batch_crop_regions, p.init_size, canvas_size, first_tile_size)

    with crop_model_cond(p.model, batch_crop_regions, p.init_size, canvas_size, first_tile_size) as model:
        samples = _sample(model, p, positive_cropped, negative_cropped, latent, denoise)

    decoded = _decode_samples(p, samples)
    p.advance(len(regions))

    result_imgs = list(p.batch)
    for image_index, result_img in enumerate(result_imgs):
        for region_index, _ in enumerate(regions):
            idx = image_index * len(regions) + region_index
            tile_sampled = tensor_to_pil(decoded, idx)
            initial_tile_size = batch_tiles[idx][1]
            crop_region = batch_crop_regions[idx]
            tile_mask = batch_masks[idx]

            if tile_sampled.size != initial_tile_size:
                tile_sampled = tile_sampled.resize(initial_tile_size, Image.Resampling.LANCZOS)

            image_tile_only = Image.new("RGBA", result_img.size)
            image_tile_only.paste(tile_sampled, crop_region[:2])
            temp = image_tile_only.copy()
            temp.putalpha(tile_mask)
            image_tile_only.paste(temp, image_tile_only)

            result = result_img.convert("RGBA")
            result.alpha_composite(image_tile_only)
            result_imgs[image_index] = result.convert("RGB")

    p.batch = result_imgs


class UltimateRedrawProcessor:
    def __init__(self, mode: USDUMode, tile_width: int, tile_height: int, padding: int, mask_blur: int):
        self.mode = mode
        self.tile_width = tile_width
        self.tile_height = tile_height
        self.padding = padding
        self.mask_blur = mask_blur

    def calc_rectangle(self, xi: int, yi: int) -> tuple[int, int, int, int]:
        x1 = xi * self.tile_width
        y1 = yi * self.tile_height
        x2 = x1 + self.tile_width
        y2 = y1 + self.tile_height
        return x1, y1, x2, y2

    def _batched_process(self, p: UltimateSDProcessing, rows: int, cols: int, coords: list[tuple[int, int]]):
        process_width = _round_up(self.tile_width + self.padding, 64)
        process_height = _round_up(self.tile_height + self.padding, 64)
        regions = [self.calc_rectangle(xi, yi) for xi, yi in coords]
        _process_tile_batch(
            p,
            regions,
            process_width=process_width,
            process_height=process_height,
            padding=self.padding,
            mask_blur=self.mask_blur,
            denoise=p.default_denoise,
        )

    def start(self, p: UltimateSDProcessing, rows: int, cols: int) -> None:
        if self.mode == USDUMode.NONE:
            return

        if self.mode == USDUMode.LINEAR:
            coords = [(xi, yi) for yi in range(rows) for xi in range(cols)]
        else:
            white = []
            black = []
            for yi in range(rows):
                for xi in range(cols):
                    is_white = (xi + yi) % 2 == 0
                    (white if is_white else black).append((xi, yi))
            coords = white + black

        tile_batch_size = p.tile_batch_size if p.force_uniform_tiles else 1
        for start in range(0, len(coords), tile_batch_size):
            self._batched_process(p, rows, cols, coords[start:start + tile_batch_size])


class UltimateSeamFixProcessor:
    def __init__(
        self,
        mode: USDUSFMode,
        tile_width: int,
        tile_height: int,
        padding: int,
        denoise: float,
        mask_blur: int,
        band_width: int,
    ):
        self.mode = mode
        self.tile_width = tile_width
        self.tile_height = tile_height
        self.padding = padding
        self.denoise = denoise
        self.mask_blur = mask_blur
        self.band_width = band_width

    def _apply_mask(
        self,
        p: UltimateSDProcessing,
        mask: Image.Image,
        process_width: int,
        process_height: int,
        padding: int,
        mask_blur: int,
    ) -> None:
        _process_tile_batch(
            p,
            regions=[mask.getbbox() or (0, 0, p.canvas_width, p.canvas_height)],
            process_width=process_width,
            process_height=process_height,
            padding=padding,
            mask_blur=mask_blur,
            denoise=self.denoise,
        )

    def _apply_full_mask(self, p: UltimateSDProcessing, mask: Image.Image, process_width: int, process_height: int, padding: int):
        canvas_size = (p.canvas_width, p.canvas_height)
        if mask.getbbox() is None:
            return

        crop_region = get_crop_region(mask, padding)
        x1, y1, x2, y2 = crop_region
        crop_w = x2 - x1
        crop_h = y2 - y1
        if p.force_uniform_tiles:
            crop_ratio = crop_w / max(crop_h, 1)
            process_ratio = process_width / max(process_height, 1)
            if crop_ratio > process_ratio:
                target_width = crop_w
                target_height = round(crop_w / max(process_ratio, 1e-6))
            else:
                target_width = round(crop_h * process_ratio)
                target_height = crop_h
            crop_region, _ = expand_crop(crop_region, p.canvas_width, p.canvas_height, target_width, target_height)
            tile_size = (process_width, process_height)
        else:
            tile_size = (_round_up(crop_w, 8), _round_up(crop_h, 8))

        if self.mask_blur > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(self.mask_blur))

        tiles = [img.crop(crop_region) for img in p.batch]
        initial_tile_size = tiles[0].size
        tiles = [
            tile if tile.size == tile_size else tile.resize(tile_size, Image.Resampling.LANCZOS)
            for tile in tiles
        ]

        positive_cropped = crop_cond(p.positive, crop_region, p.init_size, canvas_size, tile_size)
        negative_cropped = crop_cond(p.negative, crop_region, p.init_size, canvas_size, tile_size)
        batched_tensors = torch.cat([pil_to_tensor(tile) for tile in tiles], dim=0)
        latent = p.vae_encoder.encode(p.vae, batched_tensors)[0]

        with crop_model_cond(p.model, crop_region, p.init_size, canvas_size, tile_size) as model:
            samples = _sample(model, p, positive_cropped, negative_cropped, latent, self.denoise)

        decoded = _decode_samples(p, samples)
        p.advance(1)

        result_images = []
        for index, base_image in enumerate(p.batch):
            tile_sampled = tensor_to_pil(decoded, index)
            if tile_sampled.size != initial_tile_size:
                tile_sampled = tile_sampled.resize(initial_tile_size, Image.Resampling.LANCZOS)
            image_tile_only = Image.new("RGBA", base_image.size)
            image_tile_only.paste(tile_sampled, crop_region[:2])
            temp = image_tile_only.copy()
            temp.putalpha(mask)
            image_tile_only.paste(temp, image_tile_only)
            result = base_image.convert("RGBA")
            result.alpha_composite(image_tile_only)
            result_images.append(result.convert("RGB"))
        p.batch = result_images

    def _half_tile_masks(self, rows: int, cols: int):
        gradient = Image.linear_gradient("L")
        row_gradient = Image.new("L", (self.tile_width, self.tile_height), "black")
        row_gradient.paste(
            gradient.resize((self.tile_width, self.tile_height // 2), resample=Image.BICUBIC),
            (0, 0),
        )
        row_gradient.paste(
            gradient.rotate(180).resize((self.tile_width, self.tile_height // 2), resample=Image.BICUBIC),
            (0, self.tile_height // 2),
        )

        col_gradient = Image.new("L", (self.tile_width, self.tile_height), "black")
        col_gradient.paste(
            gradient.rotate(90).resize((self.tile_width // 2, self.tile_height), resample=Image.BICUBIC),
            (0, 0),
        )
        col_gradient.paste(
            gradient.rotate(270).resize((self.tile_width // 2, self.tile_height), resample=Image.BICUBIC),
            (self.tile_width // 2, 0),
        )
        return row_gradient, col_gradient

    def start(self, p: UltimateSDProcessing, rows: int, cols: int) -> None:
        if self.mode == USDUSFMode.NONE:
            return

        if self.mode == USDUSFMode.BAND_PASS:
            gradient = Image.linear_gradient("L")
            mirror_gradient = Image.new("L", (256, 256), "black")
            mirror_gradient.paste(gradient.resize((256, 128), resample=Image.BICUBIC), (0, 0))
            mirror_gradient.paste(gradient.rotate(180).resize((256, 128), resample=Image.BICUBIC), (0, 128))
            row_gradient = mirror_gradient.resize((p.canvas_width, self.band_width), resample=Image.BICUBIC)
            col_gradient = mirror_gradient.rotate(90).resize((self.band_width, p.canvas_height), resample=Image.BICUBIC)

            for xi in range(1, cols):
                mask = Image.new("L", (p.canvas_width, p.canvas_height), "black")
                mask.paste(col_gradient, (xi * self.tile_width - self.band_width // 2, 0))
                self._apply_full_mask(
                    p,
                    mask,
                    process_width=_round_up(self.band_width + self.padding * 2, 64),
                    process_height=_round_up(p.canvas_height, 8),
                    padding=self.padding,
                )

            for yi in range(1, rows):
                mask = Image.new("L", (p.canvas_width, p.canvas_height), "black")
                mask.paste(row_gradient, (0, yi * self.tile_height - self.band_width // 2))
                self._apply_full_mask(
                    p,
                    mask,
                    process_width=_round_up(p.canvas_width, 8),
                    process_height=_round_up(self.band_width + self.padding * 2, 64),
                    padding=self.padding,
                )
            return

        row_gradient, col_gradient = self._half_tile_masks(rows, cols)
        for yi in range(rows - 1):
            for xi in range(cols):
                mask = Image.new("L", (p.canvas_width, p.canvas_height), "black")
                mask.paste(row_gradient, (xi * self.tile_width, yi * self.tile_height + self.tile_height // 2))
                self._apply_full_mask(
                    p,
                    mask,
                    process_width=_round_up(self.tile_width, 64),
                    process_height=_round_up(self.tile_height, 64),
                    padding=self.padding,
                )

        for yi in range(rows):
            for xi in range(cols - 1):
                mask = Image.new("L", (p.canvas_width, p.canvas_height), "black")
                mask.paste(col_gradient, (xi * self.tile_width + self.tile_width // 2, yi * self.tile_height))
                self._apply_full_mask(
                    p,
                    mask,
                    process_width=_round_up(self.tile_width, 64),
                    process_height=_round_up(self.tile_height, 64),
                    padding=self.padding,
                )

        if self.mode != USDUSFMode.HALF_TILE_PLUS_INTERSECTIONS:
            return

        gradient = Image.radial_gradient("L").resize((self.tile_width, self.tile_height), resample=Image.BICUBIC)
        gradient = ImageOps.invert(gradient)
        for yi in range(rows - 1):
            for xi in range(cols - 1):
                mask = Image.new("L", (p.canvas_width, p.canvas_height), "black")
                mask.paste(
                    gradient,
                    (xi * self.tile_width + self.tile_width // 2, yi * self.tile_height + self.tile_height // 2),
                )
                self._apply_full_mask(
                    p,
                    mask,
                    process_width=_round_up(self.tile_width, 64),
                    process_height=_round_up(self.tile_height, 64),
                    padding=0,
                )


def count_total_jobs(redraw_mode: USDUMode, seam_fix_mode: USDUSFMode, rows: int, cols: int) -> int:
    redraw_job_count = rows * cols if redraw_mode != USDUMode.NONE else 0
    seams_job_count = 0
    if seam_fix_mode == USDUSFMode.BAND_PASS:
        seams_job_count = max(0, rows - 1) + max(0, cols - 1)
    elif seam_fix_mode == USDUSFMode.HALF_TILE:
        seams_job_count = max(0, rows - 1) * cols + max(0, cols - 1) * rows
    elif seam_fix_mode == USDUSFMode.HALF_TILE_PLUS_INTERSECTIONS:
        seams_job_count = (
            max(0, rows - 1) * cols
            + max(0, cols - 1) * rows
            + max(0, rows - 1) * max(0, cols - 1)
        )
    return max(1, redraw_job_count + seams_job_count)

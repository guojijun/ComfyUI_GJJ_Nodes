from __future__ import annotations

from contextlib import contextmanager

import torch

from .gjj_ultimate_utils import resize_region


@contextmanager
def crop_model_cond(model, crop_regions, init_size, canvas_size, tile_size, latent_crop: bool = False):
    patched_model = model.clone()
    patches = patched_model.model_options.get("transformer_options", {}).get("patches", {})
    applied_croppers = {}
    for _, module_patches in patches.items():
        for patch in module_patches:
            if id(patch) in applied_croppers:
                continue
            if type(patch).__name__ in ("DiffSynthCnetPatch", "ZImageControlPatch"):
                cropper = ModelPatchCropper(patch).crop(crop_regions, canvas_size, latent_crop)
                applied_croppers[id(patch)] = cropper
    try:
        yield patched_model
    finally:
        for cropper in applied_croppers.values():
            del cropper


class ModelPatchCropper:
    def __init__(self, patch):
        self.patch = patch
        self.original_state = {
            "image": patch.image.clone(),
            "encoded_image": patch.encoded_image.clone(),
            "encoded_image_size": patch.encoded_image_size,
        }

    def __del__(self):
        self.patch.image = self.original_state["image"]
        self.patch.encoded_image = self.original_state["encoded_image"]
        self.patch.encoded_image_size = self.original_state["encoded_image_size"]

    def crop(self, crop_regions, canvas_size, latent_crop: bool = True):
        patch = self.patch
        if not isinstance(crop_regions, list):
            crop_regions = [crop_regions]

        image_size = (patch.image.shape[2], patch.image.shape[1])
        cropped_images = []
        for crop_region in crop_regions:
            resized_crop = resize_region(crop_region, canvas_size, image_size)
            x1, y1, x2, y2 = resized_crop
            cropped_images.append(patch.image[:, y1:y2, x1:x2, :])

        concatenated_image = torch.cat(cropped_images, dim=0)
        patch.image = concatenated_image
        patch.encoded_image_size = (concatenated_image.shape[1], concatenated_image.shape[2])

        if latent_crop:
            downscale_ratio = patch.vae.spacial_compression_encode()
            cropped_latents = []
            for crop_region in crop_regions:
                resized_crop = resize_region(crop_region, canvas_size, image_size)
                x1, y1, x2, y2 = tuple(x // downscale_ratio for x in resized_crop)
                cropped_latents.append(patch.encoded_image[:, :, y1:y2, x1:x2])
            patch.encoded_image = torch.cat(cropped_latents, dim=0)
        else:
            patch.__init__(
                patch.model_patch,
                patch.vae,
                concatenated_image,
                patch.strength,
                inpaint_image=patch.inpaint_image,
                mask=patch.mask,
            )
        return self

# Positional encoding, prompt encoder, and camera encoder.

from typing import Any, Optional, Tuple

import einops
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import comfy.ops

from .layers import LayerNorm2d

ops = comfy.ops.manual_cast


# =============================================================================
# Fourier position encoding (for camera rays)
# =============================================================================

def _generate_fourier_features(pos, num_bands, max_resolution):
    b, n = pos.shape[:2]
    device = pos.device

    min_freq = 1.0
    freq_bands = torch.stack(
        [
            torch.linspace(start=min_freq, end=res / 2, steps=num_bands, device=device, dtype=pos.dtype)
            for res in max_resolution
        ],
        dim=0,
    )

    per_pos_features = torch.stack(
        [pos[i, :, :][:, :, None] * freq_bands[None, :, :] for i in range(b)], 0
    )
    per_pos_features = per_pos_features.reshape(b, n, -1)

    per_pos_features = torch.cat(
        [torch.sin(np.pi * per_pos_features), torch.cos(np.pi * per_pos_features)],
        dim=-1,
    )

    per_pos_features = torch.cat([pos, per_pos_features], dim=-1)
    return per_pos_features


class FourierPositionEncoding(nn.Module):
    def __init__(self, n, num_bands, max_resolution):
        super().__init__()
        self.num_bands = num_bands
        self.max_resolution = [max_resolution] * n

    @property
    def channels(self):
        num_dims = len(self.max_resolution)
        encoding_size = self.num_bands * num_dims
        encoding_size *= 2  # sin-cos
        encoding_size += num_dims  # concat
        return encoding_size

    def forward(self, pos):
        fourier_pos_enc = _generate_fourier_features(
            pos, num_bands=self.num_bands, max_resolution=self.max_resolution
        )
        return fourier_pos_enc


# =============================================================================
# Camera encoder
# =============================================================================

class CameraEncoder(nn.Module):
    def __init__(self, embed_dim, patch_size=14,
                 dtype=None, device=None, operations=ops):
        super().__init__()
        self.patch_size = patch_size
        self.embed_dim = embed_dim
        self.camera = FourierPositionEncoding(n=3, num_bands=16, max_resolution=64)

        self.conv = operations.Conv2d(embed_dim + 99, embed_dim, kernel_size=1, bias=False,
                                      dtype=dtype, device=device)
        self.norm = LayerNorm2d(embed_dim)

    def forward(self, img_embeddings, rays):
        B, D, _h, _w = img_embeddings.shape

        with torch.no_grad():
            scale = 1 / self.patch_size
            rays = F.interpolate(
                rays,
                scale_factor=(scale, scale),
                mode="bilinear",
                align_corners=False,
                antialias=True,
            )
            rays = rays.permute(0, 2, 3, 1).contiguous()
            rays = torch.cat([rays, torch.ones_like(rays[..., :1])], dim=-1)
            rays_embeddings = self.camera(
                pos=rays.reshape(B, -1, 3)
            )
            rays_embeddings = einops.rearrange(
                rays_embeddings, "b (h w) c -> b c h w", h=_h, w=_w
            ).contiguous()

        z = torch.concat([img_embeddings, rays_embeddings], dim=1)
        z = self.norm(self.conv(z))
        return z


# =============================================================================
# Random positional encoding
# =============================================================================

class PositionEmbeddingRandom(nn.Module):
    """Positional encoding using random spatial frequencies."""

    def __init__(self, num_pos_feats: int = 64, scale: Optional[float] = None) -> None:
        super().__init__()
        if scale is None or scale <= 0.0:
            scale = 1.0
        self.register_buffer(
            "positional_encoding_gaussian_matrix",
            scale * torch.randn((2, num_pos_feats)),
        )

    def _pe_encoding(self, coords: torch.Tensor) -> torch.Tensor:
        coords = 2 * coords - 1
        coords = coords @ self.positional_encoding_gaussian_matrix
        coords = 2 * np.pi * coords
        return torch.cat([torch.sin(coords), torch.cos(coords)], dim=-1)

    def forward(self, size: Tuple[int, int]) -> torch.Tensor:
        h, w = size
        device: Any = self.positional_encoding_gaussian_matrix.device
        dtype = self.positional_encoding_gaussian_matrix.dtype
        grid = torch.ones((h, w), device=device, dtype=dtype)
        y_embed = grid.cumsum(dim=0) - 0.5
        x_embed = grid.cumsum(dim=1) - 0.5
        y_embed = y_embed / h
        x_embed = x_embed / w
        pe = self._pe_encoding(torch.stack([x_embed, y_embed], dim=-1))
        return pe.permute(2, 0, 1)

    def forward_with_coords(
        self, coords_input: torch.Tensor, image_size: Tuple[int, int]
    ) -> torch.Tensor:
        coords = coords_input.clone()
        coords[:, :, 0] = coords[:, :, 0] / image_size[1]
        coords[:, :, 1] = coords[:, :, 1] / image_size[0]
        return self._pe_encoding(coords.to(self.positional_encoding_gaussian_matrix.dtype))


# =============================================================================
# Prompt encoder
# =============================================================================

class PromptEncoder(nn.Module):
    def __init__(
        self,
        embed_dim: int,
        num_body_joints: int,
        frozen: bool = False,
        mask_embed_type: Optional[str] = None,
        dtype=None,
        device=None,
        operations=ops,
    ) -> None:
        super().__init__()
        self.embed_dim = embed_dim
        self.num_body_joints = num_body_joints

        # Keypoint prompts
        self.pe_layer = PositionEmbeddingRandom(embed_dim // 2)
        self.point_embeddings = nn.ModuleList(
            [operations.Embedding(1, embed_dim, dtype=dtype, device=device) for _ in range(self.num_body_joints)]
        )
        self.not_a_point_embed = operations.Embedding(1, embed_dim, dtype=dtype, device=device)
        self.invalid_point_embed = operations.Embedding(1, embed_dim, dtype=dtype, device=device)

        # Mask prompt
        if mask_embed_type in ["v1"]:
            mask_in_chans = 16
            self.mask_downscaling = nn.Sequential(
                operations.Conv2d(1, mask_in_chans // 4, kernel_size=4, stride=4, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans // 4),
                nn.GELU(),
                operations.Conv2d(mask_in_chans // 4, mask_in_chans, kernel_size=4, stride=4, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans),
                nn.GELU(),
                operations.Conv2d(mask_in_chans, embed_dim, kernel_size=1, dtype=dtype, device=device),
            )
        elif mask_embed_type in ["v2"]:
            mask_in_chans = 256
            self.mask_downscaling = nn.Sequential(
                operations.Conv2d(1, mask_in_chans // 64, kernel_size=2, stride=2, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans // 64),
                nn.GELU(),
                operations.Conv2d(mask_in_chans // 64, mask_in_chans // 16, kernel_size=2, stride=2, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans // 16),
                nn.GELU(),
                operations.Conv2d(mask_in_chans // 16, mask_in_chans // 4, kernel_size=2, stride=2, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans // 4),
                nn.GELU(),
                operations.Conv2d(mask_in_chans // 4, mask_in_chans, kernel_size=2, stride=2, dtype=dtype, device=device),
                LayerNorm2d(mask_in_chans),
                nn.GELU(),
                operations.Conv2d(mask_in_chans, embed_dim, kernel_size=1, dtype=dtype, device=device),
            )
        else:
            assert mask_embed_type is None

        if mask_embed_type is not None:
            nn.init.zeros_(self.mask_downscaling[-1].weight)
            nn.init.zeros_(self.mask_downscaling[-1].bias)
            self.no_mask_embed = operations.Embedding(1, embed_dim, dtype=dtype, device=device)
            nn.init.zeros_(self.no_mask_embed.weight)

        self.frozen = frozen
        self._freeze_stages()

    def get_dense_pe(self, size: Tuple[int, int]) -> torch.Tensor:
        return self.pe_layer(size).unsqueeze(0)

    def _embed_keypoints(
        self,
        points: torch.Tensor,
        labels: torch.Tensor,
    ) -> torch.Tensor:
        assert points.min() >= 0 and points.max() <= 1
        point_embedding = self.pe_layer._pe_encoding(points.to(self.pe_layer.positional_encoding_gaussian_matrix.dtype))
        point_embedding[labels == -2] = 0.0
        point_embedding[labels == -2] += self.invalid_point_embed.weight
        point_embedding[labels == -1] = 0.0
        point_embedding[labels == -1] += self.not_a_point_embed.weight
        for i in range(self.num_body_joints):
            point_embedding[labels == i] += self.point_embeddings[i].weight
        point_mask = labels > -2
        return point_embedding, point_mask

    def _get_batch_size(
        self,
        keypoints: Optional[torch.Tensor],
        boxes: Optional[torch.Tensor],
        masks: Optional[torch.Tensor],
    ) -> int:
        if keypoints is not None:
            return keypoints.shape[0]
        elif boxes is not None:
            return boxes.shape[0]
        elif masks is not None:
            return masks.shape[0]
        else:
            return 1

    def _get_device(self) -> torch.device:
        return self.point_embeddings[0].weight.device

    def forward(
        self,
        keypoints: Optional[torch.Tensor],
        boxes: Optional[torch.Tensor] = None,
        masks: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        bs = self._get_batch_size(keypoints, boxes, masks)
        sparse_embeddings = torch.empty(
            (bs, 0, self.embed_dim), device=self._get_device(),
            dtype=self.point_embeddings[0].weight.dtype,
        )
        sparse_masks = torch.empty(
            (bs, 0), device=self._get_device(), dtype=torch.bool,
        )
        if keypoints is not None:
            coords = keypoints[:, :, :2]
            labels = keypoints[:, :, -1]
            point_embeddings, point_mask = self._embed_keypoints(coords, labels)
            sparse_embeddings = torch.cat([sparse_embeddings, point_embeddings], dim=1)
            sparse_masks = torch.cat([sparse_masks, point_mask], dim=1)
        return sparse_embeddings, sparse_masks

    def get_mask_embeddings(
        self,
        masks: Optional[torch.Tensor] = None,
        bs: int = 1,
        size: Tuple[int, int] = (16, 16),
    ) -> torch.Tensor:
        no_mask_embeddings = self.no_mask_embed.weight.reshape(1, -1, 1, 1).expand(
            bs, -1, size[0], size[1]
        )
        if masks is not None:
            mask_embeddings = self.mask_downscaling(masks)
        else:
            mask_embeddings = no_mask_embeddings
        return mask_embeddings, no_mask_embeddings

    def _freeze_stages(self):
        if self.frozen:
            for param in self.parameters():
                param.requires_grad = False

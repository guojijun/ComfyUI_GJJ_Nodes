from __future__ import annotations

import torch


class SPLAT:
    """Vendored from D:/AI/CUI/ComfyUI comfy_api.latest geometry types."""

    def __init__(
        self,
        positions: torch.Tensor,
        scales: torch.Tensor,
        rotations: torch.Tensor,
        opacities: torch.Tensor,
        sh: torch.Tensor,
        counts: torch.Tensor | None = None,
    ):
        self.positions = positions
        self.scales = scales
        self.rotations = rotations
        self.opacities = opacities
        self.sh = sh
        self.counts = counts


class MESH:
    """Vendored from D:/AI/CUI/ComfyUI comfy_api.latest geometry types."""

    def __init__(
        self,
        vertices: torch.Tensor,
        faces: torch.Tensor,
        uvs: torch.Tensor | None = None,
        vertex_colors: torch.Tensor | None = None,
        texture: torch.Tensor | None = None,
        vertex_counts: torch.Tensor | None = None,
        face_counts: torch.Tensor | None = None,
        unlit: bool = False,
    ):
        assert (vertex_counts is None) == (face_counts is None), (
            "vertex_counts and face_counts must be provided together (both or neither)"
        )
        self.vertices = vertices
        self.faces = faces
        self.uvs = uvs
        self.vertex_colors = vertex_colors
        self.texture = texture
        self.vertex_counts = vertex_counts
        self.face_counts = face_counts
        self.unlit = unlit

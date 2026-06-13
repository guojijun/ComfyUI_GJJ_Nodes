import sys

import torch
from einops import rearrange
from . import globals as enhance_globals


_PEER_GLOBALS = None


def _get_peer_globals():
    global _PEER_GLOBALS
    if _PEER_GLOBALS is not None:
        return _PEER_GLOBALS

    local_name = enhance_globals.__name__
    for module_name, module in tuple(sys.modules.items()):
        if (
            module is not None
            and module_name != local_name
            and module_name.endswith(".enhance_a_video.globals")
            and callable(getattr(module, "get_enhance_weight", None))
            and callable(getattr(module, "get_num_frames", None))
        ):
            try:
                has_runtime_state = (
                    module.get_enhance_weight() is not None
                    or module.get_num_frames() is not None
                )
            except Exception:
                has_runtime_state = False
            if has_runtime_state:
                _PEER_GLOBALS = module
                return module
    return None


def _resolve_num_frames(explicit_num_frames, sequence_length):
    candidates = [explicit_num_frames, enhance_globals.get_num_frames()]
    peer_globals = _get_peer_globals()
    if peer_globals is not None:
        candidates.append(peer_globals.get_num_frames())

    for value in candidates:
        try:
            num_frames = int(value)
        except (TypeError, ValueError):
            continue
        if num_frames > 0 and sequence_length % num_frames == 0:
            return num_frames

    raise RuntimeError(
        "FETA 无法确定有效 latent 帧数。请确认采样器与 WANVIDEOMODEL 使用兼容的 WanVideo runtime。"
    )


def _resolve_enhance_weight():
    weight = enhance_globals.get_enhance_weight()
    if weight is None:
        peer_globals = _get_peer_globals()
        if peer_globals is not None:
            weight = peer_globals.get_enhance_weight()
    if weight is None:
        raise RuntimeError(
            "FETA 增强已启用，但未读取到增强权重。请重新执行 FETA 参数节点后再采样。"
        )
    return float(weight)

@torch.compiler.disable()
def get_feta_scores(query, key, num_frames=None):
    img_q, img_k = query, key

    B, S, N, C = img_q.shape
    num_frames = _resolve_num_frames(num_frames, S)

    # Calculate spatial dimension
    spatial_dim = S // num_frames
    
    # Add time dimension between spatial and head dims
    query_image = img_q.reshape(B, spatial_dim, num_frames, N, C)
    key_image = img_k.reshape(B, spatial_dim, num_frames, N, C)
    
    # Expand time dimension
    query_image = query_image.expand(-1, -1, num_frames, -1, -1)  # [B, S, T, N, C]
    key_image = key_image.expand(-1, -1, num_frames, -1, -1)      # [B, S, T, N, C]
    
    # Reshape to match feta_score input format: [(B S) N T C]
    query_image = rearrange(query_image, "b s t n c -> (b s) n t c")  #torch.Size([3200, 24, 5, 128])
    key_image = rearrange(key_image, "b s t n c -> (b s) n t c")
    
    return feta_score(query_image, key_image, C, num_frames)

@torch.compiler.disable()
def feta_score(query_image, key_image, head_dim, num_frames):
    scale = head_dim**-0.5
    query_image = query_image * scale
    attn_temp = query_image @ key_image.transpose(-2, -1)  # translate attn to float32
    attn_temp = attn_temp.to(torch.float32)
    attn_temp = attn_temp.softmax(dim=-1)

    # Reshape to [batch_size * num_tokens, num_frames, num_frames]
    attn_temp = attn_temp.reshape(-1, num_frames, num_frames)

    # Create a mask for diagonal elements
    diag_mask = torch.eye(num_frames, device=attn_temp.device).bool()
    diag_mask = diag_mask.unsqueeze(0).expand(attn_temp.shape[0], -1, -1)

    # Zero out diagonal elements
    attn_wo_diag = attn_temp.masked_fill(diag_mask, 0)

    # Calculate mean for each token's attention matrix
    # Number of off-diagonal elements per matrix is n*n - n
    num_off_diag = num_frames * num_frames - num_frames
    mean_scores = attn_wo_diag.sum(dim=(1, 2)) / num_off_diag

    enhance_scores = mean_scores.mean() * (num_frames + _resolve_enhance_weight())
    enhance_scores = enhance_scores.clamp(min=1)
    return enhance_scores

import dataclasses
import logging
from pathlib import Path
from typing import Optional

import torch

from .model.flow_matching import FlowMatching
from .model.networks import MMAudio
from .model.sequence_config import (CONFIG_16K, CONFIG_44K, SequenceConfig)
from .model.utils.features_utils import FeaturesUtils

log = logging.getLogger()

@dataclasses.dataclass
class ModelConfig:
    model_name: str
    model_path: Path
    vae_path: Path
    bigvgan_16k_path: Optional[Path]
    mode: str
    synchformer_ckpt: Path = Path('./ext_weights/synchformer_state_dict.pth')

    @property
    def seq_cfg(self) -> SequenceConfig:
        if self.mode == '16k':
            return CONFIG_16K
        elif self.mode == '44k':
            return CONFIG_44K

def generate(clip_video: Optional[torch.Tensor],
             sync_video: Optional[torch.Tensor],
             text: Optional[list[str]],
             *,
             negative_text: Optional[list[str]] = None,
             feature_utils: FeaturesUtils,
             net: MMAudio,
             fm: FlowMatching,
             rng: torch.Generator,
             cfg_strength: float):
    device = feature_utils.device
    dtype = feature_utils.dtype

    bs = len(text)
    if clip_video is not None and feature_utils.clip_model is not None:
        clip_video = clip_video.to(device, dtype, non_blocking=True)
        clip_features = feature_utils.encode_video_with_clip(clip_video, batch_size=bs)
    else:
        clip_features = net.get_empty_clip_sequence(bs)

    if sync_video is not None:
        sync_video = sync_video.to(device, dtype, non_blocking=True)
        sync_features = feature_utils.encode_video_with_sync(sync_video, batch_size=bs)
    else:
        sync_features = net.get_empty_sync_sequence(bs)

    if text is not None and feature_utils.clip_model is not None and feature_utils.tokenizer is not None:
        text_features = feature_utils.encode_text(text)
    else:
        text_features = net.get_empty_string_sequence(bs)

    if negative_text is not None and feature_utils.clip_model is not None and feature_utils.tokenizer is not None:
        assert len(negative_text) == bs
        negative_text_features = feature_utils.encode_text(negative_text)
    else:
        negative_text_features = net.get_empty_string_sequence(bs)

    x0 = torch.randn(bs,
                     net.latent_seq_len,
                     net.latent_dim,
                     device=device,
                     dtype=dtype,
                     generator=rng)
    preprocessed_conditions = net.preprocess_conditions(clip_features, sync_features, text_features)
    empty_conditions = net.get_empty_conditions(
        bs, negative_text_features=negative_text_features if negative_text is not None else None)

    cfg_ode_wrapper = lambda t, x: net.ode_wrapper(t, x, preprocessed_conditions, empty_conditions,
                                                   cfg_strength)
    x1 = fm.to_data(cfg_ode_wrapper, x0)
    x1 = net.unnormalize(x1)
    spec = feature_utils.decode(x1)
    audio = feature_utils.vocode(spec)
    return audio

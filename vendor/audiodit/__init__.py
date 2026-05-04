from .configuration_audiodit import AudioDiTConfig, AudioDiTVaeConfig
from .modeling_audiodit import (
    AudioDiTModel,
    AudioDiTPreTrainedModel,
    AudioDiTTransformer,
    AudioDiTVae,
    AudioDiTOutput,
)

from transformers import AutoConfig, AutoModel

AutoConfig.register("audiodit", AudioDiTConfig, exist_ok=True)
AutoModel.register(AudioDiTConfig, AudioDiTModel, exist_ok=True)

__all__ = [
    "AudioDiTConfig",
    "AudioDiTVaeConfig",
    "AudioDiTModel",
    "AudioDiTPreTrainedModel",
    "AudioDiTTransformer",
    "AudioDiTVae",
    "AudioDiTOutput",
]

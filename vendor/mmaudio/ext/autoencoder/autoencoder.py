from typing import Any, Literal, Optional

import torch
import torch.nn as nn

from ...ext.autoencoder.vae import VAE, get_my_vae
from ...model.utils.distributions import DiagonalGaussianDistribution


class AutoEncoderModule(nn.Module):

    def __init__(self,
                 *,
                 vae_state_dict,
                 bigvgan_vocoder: Optional[Any] = None,
                 mode: Literal['16k', '44k']):
        super().__init__()
        self.vae: VAE = get_my_vae(mode).eval()
        self.vae.load_state_dict(vae_state_dict)
        self.vae.remove_weight_norm()

        self.vocoder = bigvgan_vocoder
        if mode == '44k':
            self.vocoder.remove_weight_norm()

        for param in self.parameters():
            param.requires_grad = False

    @torch.inference_mode()
    def encode(self, x: torch.Tensor) -> DiagonalGaussianDistribution:
        return self.vae.encode(x)

    @torch.inference_mode()
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        return self.vae.decode(z)

    @torch.inference_mode()
    def vocode(self, spec: torch.Tensor) -> torch.Tensor:
        return self.vocoder(spec)

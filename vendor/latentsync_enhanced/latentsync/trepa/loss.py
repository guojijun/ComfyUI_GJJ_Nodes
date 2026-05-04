# Copyright (c) 2024 Bytedance Ltd. and/or its affiliates
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import torch
import torch.nn.functional as F
from einops import rearrange
from .third_party.VideoMAEv2.utils import load_videomae_model
from ..utils.util import check_model_and_download


class TREPALoss:
    def __init__(
        self,
        device="cuda",
        ckpt_path="checkpoints/auxiliary/vit_g_hybrid_pt_1200e_ssv2_ft.pth",
        with_cp=False,
    ):
        check_model_and_download(ckpt_path)
        self.model = load_videomae_model(device, ckpt_path, with_cp).eval().to(dtype=torch.float16)
        self.model.requires_grad_(False)

    def __call__(self, videos_fake, videos_real):
        batch_size = videos_fake.shape[0]
        num_frames = videos_fake.shape[2]
        videos_fake = rearrange(videos_fake.clone(), "b c f h w -> (b f) c h w")
        videos_real = rearrange(videos_real.clone(), "b c f h w -> (b f) c h w")

        videos_fake = F.interpolate(videos_fake, size=(224, 224), mode="bicubic")
        videos_real = F.interpolate(videos_real, size=(224, 224), mode="bicubic")

        videos_fake = rearrange(videos_fake, "(b f) c h w -> b c f h w", f=num_frames)
        videos_real = rearrange(videos_real, "(b f) c h w -> b c f h w", f=num_frames)

        # Because input pixel range is [-1, 1], and model expects pixel range to be [0, 1]
        videos_fake = (videos_fake / 2 + 0.5).clamp(0, 1)
        videos_real = (videos_real / 2 + 0.5).clamp(0, 1)

        feats_fake = self.model.forward_features(videos_fake)
        feats_real = self.model.forward_features(videos_real)

        feats_fake = F.normalize(feats_fake, p=2, dim=1)
        feats_real = F.normalize(feats_real, p=2, dim=1)

        return F.mse_loss(feats_fake, feats_real)


if __name__ == "__main__":
    torch.manual_seed(42)

    # input shape: (b, c, f, h, w)
    videos_fake = torch.randn(2, 3, 16, 256, 256, requires_grad=True).to(device="cuda", dtype=torch.float16)
    videos_real = torch.randn(2, 3, 16, 256, 256, requires_grad=True).to(device="cuda", dtype=torch.float16)

    trepa_loss = TREPALoss(device="cuda", with_cp=True)
    loss = trepa_loss(videos_fake, videos_real)
    print(loss)

from typing import Literal, Optional

try:
    import open_clip
except Exception:
    open_clip = None
import torch
import torch.nn as nn
import torch.nn.functional as F
from einops import rearrange
from torchvision.transforms import Normalize


from ...model.utils.distributions import DiagonalGaussianDistribution


def patch_clip(clip_model):
    # a hack to make it output last hidden states
    # https://github.com/mlfoundations/open_clip/blob/fc5a37b72d705f760ebbc7915b84729816ed471f/src/open_clip/model.py#L269
    def new_encode_text(self, text, normalize: bool = False):
        cast_dtype = self.transformer.get_cast_dtype()

        x = self.token_embedding(text).to(cast_dtype)  # [batch_size, n_ctx, d_model]

        x = x + self.positional_embedding.to(cast_dtype)
        x = self.transformer(x, attn_mask=self.attn_mask)
        x = self.ln_final(x)  # [batch_size, n_ctx, transformer.width]
        return F.normalize(x, dim=-1) if normalize else x

    clip_model.encode_text = new_encode_text.__get__(clip_model)
    return clip_model


class FeaturesUtils(nn.Module):

    def __init__(
        self,
        *,
        vae: None,
        synchformer: None,
        clip_model: None,
        enable_conditions: bool = True,
    ):
        super().__init__()

        if enable_conditions:
            #self.clip_model = create_model_from_pretrained('hf-hub:apple/DFN5B-CLIP-ViT-H-14-384',
            #                                               return_transform=False)
            self.clip_model = clip_model
            if self.clip_model is not None:
                self.clip_preprocess = Normalize(mean=[0.48145466, 0.4578275, 0.40821073],
                                                 std=[0.26862954, 0.26130258, 0.27577711])
                self.clip_model = patch_clip(self.clip_model)
            else:
                self.clip_preprocess = None

            self.synchformer = synchformer

            self.tokenizer = open_clip.get_tokenizer('ViT-H-14-378-quickgelu') if open_clip is not None else None  # same as 'ViT-H-14'
        else:
            self.clip_model = None
            self.synchformer = None
            self.tokenizer = None

        
        self.tod = vae
        self.mel_converter = None

    def compile(self):
        if self.clip_model is not None:
            self.encode_video_with_clip = torch.compile(self.encode_video_with_clip)
            self.clip_model.encode_image = torch.compile(self.clip_model.encode_image)
            self.clip_model.encode_text = torch.compile(self.clip_model.encode_text)
        if self.synchformer is not None:
            self.synchformer = torch.compile(self.synchformer)
        self.tod.encode = torch.compile(self.tod.encode)
        self.decode = torch.compile(self.decode)
        self.vocode = torch.compile(self.vocode)

    def train(self, mode: bool) -> None:
        return super().train(False)

    @torch.inference_mode()
    def encode_video_with_clip(self, x: torch.Tensor, batch_size: int = -1) -> torch.Tensor:
        assert self.clip_model is not None, 'CLIP is not loaded'
        # x: (B, T, C, H, W) H/W: 384
        b, t, c, h, w = x.shape
        assert c == 3 and h == 384 and w == 384
        x = self.clip_preprocess(x)
        x = rearrange(x, 'b t c h w -> (b t) c h w')
        outputs = []
        if batch_size < 0:
            batch_size = b * t
        for i in range(0, b * t, batch_size):
            outputs.append(self.clip_model.encode_image(x[i:i + batch_size], normalize=True))
        x = torch.cat(outputs, dim=0)
        # x = self.clip_model.encode_image(x, normalize=True)
        x = rearrange(x, '(b t) d -> b t d', b=b)
        return x

    @torch.inference_mode()
    def encode_video_with_sync(self, x: torch.Tensor, batch_size: int = -1) -> torch.Tensor:
        assert self.synchformer is not None, 'Synchformer is not loaded'
        # x: (B, T, C, H, W) H/W: 384

        b, t, c, h, w = x.shape
        assert c == 3 and h == 224 and w == 224

        # partition the video
        segment_size = 16
        step_size = 8
        num_segments = (t - segment_size) // step_size + 1
        segments = []
        for i in range(num_segments):
            segments.append(x[:, i * step_size:i * step_size + segment_size])
        x = torch.stack(segments, dim=1)  # (B, S, T, C, H, W)

        outputs = []
        if batch_size < 0:
            batch_size = b
        for i in range(0, b, batch_size):
            outputs.append(self.synchformer(x[i:i + batch_size]))
        x = torch.cat(outputs, dim=0).flatten(start_dim=1, end_dim=2)
        return x

    @torch.inference_mode()
    def encode_text(self, text: list[str]) -> torch.Tensor:
        assert self.clip_model is not None, 'CLIP is not loaded'
        assert self.tokenizer is not None, 'Tokenizer is not loaded'
        # x: (B, L)
        tokens = self.tokenizer(text).to(self.device)
        return self.clip_model.encode_text(tokens, normalize=True)

    @torch.inference_mode()
    def encode_audio(self, x) -> DiagonalGaussianDistribution:
        assert self.tod is not None, 'VAE is not loaded'
        if self.mel_converter is None:
            from ...ext.mel_converter import MelConverter
            self.mel_converter = MelConverter().to(self.device)
        # x: (B * L)
        mel = self.mel_converter(x)
        dist = self.tod.encode(mel)

        return dist

    @torch.inference_mode()
    def vocode(self, mel: torch.Tensor) -> torch.Tensor:
        assert self.tod is not None, 'VAE is not loaded'
        return self.tod.vocode(mel)

    @torch.inference_mode()
    def decode(self, z: torch.Tensor) -> torch.Tensor:
        assert self.tod is not None, 'VAE is not loaded'
        return self.tod.decode(z.transpose(1, 2))

    @property
    def device(self):
        return next(self.parameters()).device

    @property
    def dtype(self):
        return next(self.parameters()).dtype

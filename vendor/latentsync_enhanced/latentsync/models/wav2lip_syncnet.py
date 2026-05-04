# Adapted from https://github.com/primepake/wav2lip_288x288/blob/master/models/syncnetv2.py
# The code here is for ablation study.

from torch import nn
from torch.nn import functional as F


class Wav2LipSyncNet(nn.Module):
    def __init__(self, act_fn="leaky"):
        super().__init__()

        # input image sequences: (15, 128, 256)
        self.visual_encoder = nn.Sequential(
            Conv2d(15, 32, kernel_size=(7, 7), stride=1, padding=3, act_fn=act_fn), # (128, 256)
            Conv2d(32, 64, kernel_size=5, stride=(1, 2), padding=1, act_fn=act_fn), # (126, 127)
            Conv2d(64, 64, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(64, 64, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(64, 128, kernel_size=3, stride=2, padding=1, act_fn=act_fn), # (63, 64)
            Conv2d(128, 128, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(128, 128, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(128, 128, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(128, 256, kernel_size=3, stride=3, padding=1, act_fn=act_fn), # (21, 22)
            Conv2d(256, 256, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(256, 256, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(256, 512, kernel_size=3, stride=2, padding=1, act_fn=act_fn), # (11, 11)
            Conv2d(512, 512, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(512, 512, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(512, 1024, kernel_size=3, stride=2, padding=1, act_fn=act_fn), # (6, 6)
            Conv2d(1024, 1024, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(1024, 1024, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(1024, 1024, kernel_size=3, stride=2, padding=1, act_fn="relu"), # (3, 3)
            Conv2d(1024, 1024, kernel_size=3, stride=1, padding=0, act_fn="relu"), # (1, 1)
            Conv2d(1024, 1024, kernel_size=1, stride=1, padding=0, act_fn="relu"),
        )

        # input audio sequences: (1, 80, 16)
        self.audio_encoder = nn.Sequential(
            Conv2d(1, 32, kernel_size=3, stride=1, padding=1, act_fn=act_fn),
            Conv2d(32, 32, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(32, 32, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(32, 64, kernel_size=3, stride=(3, 1), padding=1, act_fn=act_fn), # (27, 16)
            Conv2d(64, 64, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(64, 64, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(64, 128, kernel_size=3, stride=3, padding=1, act_fn=act_fn), # (9, 6)
            Conv2d(128, 128, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(128, 128, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(128, 256, kernel_size=3, stride=(3, 2), padding=1, act_fn=act_fn), # (3, 3)
            Conv2d(256, 256, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(256, 256, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(256, 512, kernel_size=3, stride=1, padding=1, act_fn=act_fn),
            Conv2d(512, 512, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(512, 512, kernel_size=3, stride=1, padding=1, residual=True, act_fn=act_fn),
            Conv2d(512, 1024, kernel_size=3, stride=1, padding=0, act_fn="relu"), # (1, 1)
            Conv2d(1024, 1024, kernel_size=1, stride=1, padding=0, act_fn="relu"),
        )

    def forward(self, image_sequences, audio_sequences):
        vision_embeds = self.visual_encoder(image_sequences)  # (b, c, 1, 1)
        audio_embeds = self.audio_encoder(audio_sequences)  # (b, c, 1, 1)

        vision_embeds = vision_embeds.reshape(vision_embeds.shape[0], -1)  # (b, c)
        audio_embeds = audio_embeds.reshape(audio_embeds.shape[0], -1)  # (b, c)

        # Make them unit vectors
        vision_embeds = F.normalize(vision_embeds, p=2, dim=1)
        audio_embeds = F.normalize(audio_embeds, p=2, dim=1)

        return vision_embeds, audio_embeds


class Conv2d(nn.Module):
    def __init__(self, cin, cout, kernel_size, stride, padding, residual=False, act_fn="relu", *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.conv_block = nn.Sequential(nn.Conv2d(cin, cout, kernel_size, stride, padding), nn.BatchNorm2d(cout))
        if act_fn == "relu":
            self.act_fn = nn.ReLU()
        elif act_fn == "tanh":
            self.act_fn = nn.Tanh()
        elif act_fn == "silu":
            self.act_fn = nn.SiLU()
        elif act_fn == "leaky":
            self.act_fn = nn.LeakyReLU(0.2, inplace=True)

        self.residual = residual

    def forward(self, x):
        out = self.conv_block(x)
        if self.residual:
            out += x
        return self.act_fn(out)

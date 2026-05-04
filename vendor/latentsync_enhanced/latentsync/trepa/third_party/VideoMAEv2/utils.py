import os
import torch
import requests
from tqdm import tqdm
from torchvision import transforms
from .videomaev2_finetune import vit_giant_patch14_224


def to_normalized_float_tensor(vid):
    return vid.permute(3, 0, 1, 2).to(torch.float32) / 255


# NOTE: for those functions, which generally expect mini-batches, we keep them
# as non-minibatch so that they are applied as if they were 4d (thus image).
# this way, we only apply the transformation in the spatial domain
def resize(vid, size, interpolation="bilinear"):
    # NOTE: using bilinear interpolation because we don't work on minibatches
    # at this level
    scale = None
    if isinstance(size, int):
        scale = float(size) / min(vid.shape[-2:])
        size = None
    return torch.nn.functional.interpolate(vid, size=size, scale_factor=scale, mode=interpolation, align_corners=False)


class ToFloatTensorInZeroOne(object):
    def __call__(self, vid):
        return to_normalized_float_tensor(vid)


class Resize(object):
    def __init__(self, size):
        self.size = size

    def __call__(self, vid):
        return resize(vid, self.size)


def preprocess_videomae(videos):
    transform = transforms.Compose([ToFloatTensorInZeroOne(), Resize((224, 224))])
    return torch.stack([transform(f) for f in torch.from_numpy(videos)])


def load_videomae_model(device, ckpt_path=None, with_cp=False):
    if ckpt_path is None:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        ckpt_path = os.path.join(current_dir, "vit_g_hybrid_pt_1200e_ssv2_ft.pth")

    if not os.path.exists(ckpt_path):
        # download the ckpt to the path
        ckpt_url = "https://pjlab-gvm-data.oss-cn-shanghai.aliyuncs.com/internvideo/videomaev2/vit_g_hybrid_pt_1200e_ssv2_ft.pth"
        response = requests.get(ckpt_url, stream=True, allow_redirects=True)
        total_size = int(response.headers.get("content-length", 0))
        block_size = 1024

        with tqdm(total=total_size, unit="B", unit_scale=True) as progress_bar:
            with open(ckpt_path, "wb") as fw:
                for data in response.iter_content(block_size):
                    progress_bar.update(len(data))
                    fw.write(data)

    model = vit_giant_patch14_224(
        img_size=224,
        pretrained=False,
        num_classes=174,
        all_frames=16,
        tubelet_size=2,
        drop_path_rate=0.3,
        use_mean_pooling=True,
        with_cp=with_cp,
    )

    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    for model_key in ["model", "module"]:
        if model_key in ckpt:
            ckpt = ckpt[model_key]
            break
    model.load_state_dict(ckpt)

    del ckpt
    torch.cuda.empty_cache()
    return model.to(device)

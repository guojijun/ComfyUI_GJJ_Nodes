import os
import torch
import folder_paths
import comfy.utils
import comfy.model_management as model_management
from comfy.sd import VAE

NODE_NAME = "GJJ_VAELoader"
CATEGORY = "GJJ/loader"


class GJJ_VAELoader:
    video_taes = ["taehv", "lighttaew2_2", "lighttaew2_1", "lighttaehy1_5"]
    image_taes = ["taesd", "taesdxl", "taesd3", "taef1"]

    @classmethod
    def vae_list(cls):
        vaes = folder_paths.get_filename_list("vae")
        approx_vaes = folder_paths.get_filename_list("vae_approx")

        # 用 "ltx" 过滤，不区分大小写，不分子目录
        vaes = [v for v in vaes if "ltx" in v.lower()]
        approx_vaes = [v for v in approx_vaes if "ltx" in v.lower()]
        sd1_taesd_dec = False
        sd1_taesd_enc = False
        sdxl_taesd_dec = False
        sdxl_taesd_enc = False
        sd3_taesd_dec = False
        sd3_taesd_enc = False
        f1_taesd_dec = False
        f1_taesd_enc = False

        for v in approx_vaes:
            if v.startswith("taesd_decoder."):
                sd1_taesd_dec = True
            elif v.startswith("taesd_encoder."):
                sd1_taesd_enc = True
            elif v.startswith("taesdxl_decoder."):
                sdxl_taesd_dec = True
            elif v.startswith("taesdxl_encoder."):
                sdxl_taesd_enc = True
            elif v.startswith("taesd3_decoder."):
                sd3_taesd_dec = True
            elif v.startswith("taesd3_encoder."):
                sd3_taesd_enc = True
            elif v.startswith("taef1_encoder."):
                f1_taesd_dec = True
            elif v.startswith("taef1_decoder."):
                f1_taesd_enc = True
            else:
                for tae in cls.video_taes:
                    if v.startswith(tae):
                        vaes.append(v)

        if sd1_taesd_dec and sd1_taesd_enc:
            vaes.append("taesd")
        if sdxl_taesd_dec and sdxl_taesd_enc:
            vaes.append("taesdxl")
        if sd3_taesd_dec and sd3_taesd_enc:
            vaes.append("taesd3")
        if f1_taesd_dec and f1_taesd_enc:
            vaes.append("taef1")
        vaes.append("pixel_space")
        return vaes

    @classmethod
    def load_taesd(cls, name):
        sd = {}
        approx_vaes = folder_paths.get_filename_list("vae_approx")

        encoder = next(
            filter(lambda a: a.startswith("{}_encoder.".format(name)), approx_vaes)
        )
        decoder = next(
            filter(lambda a: a.startswith("{}_decoder.".format(name)), approx_vaes)
        )

        enc = comfy.utils.load_torch_file(
            folder_paths.get_full_path_or_raise("vae_approx", encoder)
        )
        for k in enc:
            sd["taesd_encoder.{}".format(k)] = enc[k]

        dec = comfy.utils.load_torch_file(
            folder_paths.get_full_path_or_raise("vae_approx", decoder)
        )
        for k in dec:
            sd["taesd_decoder.{}".format(k)] = dec[k]

        if name == "taesd":
            sd["vae_scale"] = torch.tensor(0.18215)
            sd["vae_shift"] = torch.tensor(0.0)
        elif name == "taesdxl":
            sd["vae_scale"] = torch.tensor(0.13025)
            sd["vae_shift"] = torch.tensor(0.0)
        elif name == "taesd3":
            sd["vae_scale"] = torch.tensor(1.5305)
            sd["vae_shift"] = torch.tensor(0.0609)
        elif name == "taef1":
            sd["vae_scale"] = torch.tensor(0.3611)
            sd["vae_shift"] = torch.tensor(0.1159)
        return sd

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae_name": (
                    cls.vae_list(),
                    {"display_name": "VAE 选择", "tooltip": "选择要加载的 VAE 模型"},
                ),
                "device": (
                    ["main_device", "cpu"],
                    {
                        "display_name": "设备",
                        "default": "main_device",
                        "tooltip": "加载到主设备或 CPU",
                    },
                ),
                "weight_dtype": (
                    ["bf16", "fp16", "fp32"],
                    {
                        "display_name": "权重精度",
                        "default": "bf16",
                        "tooltip": "VAE 权重的精度格式",
                    },
                ),
            },
        }

    RETURN_TYPES = ("VAE",)
    RETURN_NAMES = ("VAE",)
    OUTPUT_NODE = False
    FUNCTION = "load_vae"
    CATEGORY = CATEGORY

    def load_vae(self, vae_name, device, weight_dtype):
        metadata = None
        dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[
            weight_dtype
        ]
        if device == "main_device":
            device = model_management.get_torch_device()
        elif device == "cpu":
            device = torch.device("cpu")

        try:
            if vae_name == "pixel_space":
                sd = {}
                sd["pixel_space_vae"] = torch.tensor(1.0)
            elif vae_name in self.image_taes:
                sd = self.load_taesd(vae_name)
            else:
                # 检查是否是视频 VAE
                vae_basename = os.path.splitext(vae_name)[0]
                if vae_basename in self.video_taes:
                    vae_path = folder_paths.get_full_path_or_raise(
                        "vae_approx", vae_name
                    )
                else:
                    vae_path = folder_paths.get_full_path_or_raise("vae", vae_name)
                print(f"[GJJ VAE Loader] 加载 VAE: {vae_path}")
                sd, metadata = comfy.utils.load_torch_file(
                    vae_path, return_metadata=True
                )
                print(f"[GJJ VAE Loader] 加载成功，state dict 键数: {len(sd)}")

            # 检测是否是音频 VAE
            is_audio_vae = (
                "vocoder.conv_post.weight" in sd
                or "vocoder.vocoder.conv_post.weight" in sd
                or "vocoder.resblocks.0.convs1.0.weight" in sd
                or "vocoder.vocoder.resblocks.0.convs1.0.weight" in sd
            )
            print(f"[GJJ VAE Loader] 是否音频 VAE: {is_audio_vae}")

            if is_audio_vae:
                print(f"[GJJ VAE Loader] 尝试加载音频 VAE")
                # 尝试加载音频 VAE（遵循原始代码逻辑）
                try:
                    # 尝试使用 state_dict_prefix_replace（如果可用）
                    if hasattr(comfy.utils, "state_dict_prefix_replace"):
                        print(f"[GJJ VAE Loader] 使用 state_dict_prefix_replace")
                        sd_audio = comfy.utils.state_dict_prefix_replace(
                            dict(sd),
                            {"audio_vae.": "autoencoder.", "vocoder.": "vocoder."},
                            filter_keys=True,
                        )
                        vae = VAE(sd=sd_audio, metadata=metadata)
                        vae.throw_exception_if_invalid()
                    else:
                        # 回退到直接使用原始 state dict
                        print(
                            f"[GJJ VAE Loader] state_dict_prefix_replace 不可用，直接加载"
                        )
                        vae = VAE(sd=sd, metadata=metadata)
                        vae.throw_exception_if_invalid()
                except Exception as first_exc:
                    print(f"[GJJ VAE Loader] 首次尝试失败: {str(first_exc)}")
                    # 尝试使用 AudioVAE 类
                    try:
                        print(f"[GJJ VAE Loader] 尝试使用 AudioVAE 类")
                        from comfy.ldm.lightricks.vae.audio_vae import AudioVAE

                        vae = AudioVAE(sd, metadata)
                    except Exception as fallback_exc:
                        print(
                            f"[GJJ VAE Loader] AudioVAE 加载失败: {str(fallback_exc)}"
                        )
                        raise RuntimeError(f"无法加载音频 VAE: {str(fallback_exc)}")
            else:
                # 普通 VAE
                print(f"[GJJ VAE Loader] 加载普通 VAE，设备: {device}, 精度: {dtype}")
                vae = VAE(sd=sd, device=device, dtype=dtype, metadata=metadata)
                vae.throw_exception_if_invalid()

            print(f"[GJJ VAE Loader] VAE 加载成功")
            return (vae,)

        except Exception as e:
            print(f"[GJJ VAE Loader] 加载失败 ({vae_name}): {str(e)}")
            import traceback

            traceback.print_exc()
            raise RuntimeError(f"VAE 加载失败: {str(e)}") from e


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_VAELoader}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ ·⚙ VAE 加载器(LTX)"}

import time
import struct
import math
import io
from io import BytesIO
from threading import Thread

import torch
import torch.nn.functional as F
from PIL import Image

import comfy
import comfy.utils
import comfy.model_management as mm

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _get_preview_server():
    try:
        from server import PromptServer
        return PromptServer.instance
    except Exception:
        return None


class GJJ_WrappedPreviewer:
    """简化的 latent 预览器，用于在采样过程中生成预览图像。"""

    def __init__(self, latent_rgb_factors, latent_rgb_factors_bias, rate=8, taeltx_vae=None):
        self.first_preview = True
        self.taeltx_vae = taeltx_vae
        self.last_time = 0
        self.c_index = 0
        self.rate = rate
        self.latent_rgb_factors = torch.tensor(latent_rgb_factors, device="cpu").transpose(0, 1)
        self.latent_rgb_factors_bias = torch.tensor(latent_rgb_factors_bias, device="cpu") if latent_rgb_factors_bias is not None else None
        self.device = mm.get_torch_device()

    def decode_latent_to_preview_image(self, preview_format, x0):
        if x0.ndim == 5:
            x0 = x0.movedim(2, 1)
            x0 = x0.reshape((-1,) + x0.shape[-3:])

        num_images = x0.size(0)
        new_time = time.time()
        num_previews = int((new_time - self.last_time) * self.rate)
        self.last_time = self.last_time + num_previews / self.rate

        if num_previews > num_images:
            num_previews = num_images
        elif num_previews <= 0:
            return None

        if self.first_preview:
            self.first_preview = False
            server = _get_preview_server()
            if server:
                try:
                    server.send_sync('VHS_latentpreview', {'length': num_images, 'rate': self.rate, 'id': getattr(server, 'last_node_id', None)})
                except Exception:
                    pass
            self.last_time = new_time + 1 / self.rate

        if self.c_index + num_previews > num_images:
            x0 = x0.roll(-self.c_index, 0)[:num_previews]
        else:
            x0 = x0[self.c_index:self.c_index + num_previews]

        Thread(target=self.process_previews, args=(x0, self.c_index, num_images)).run()
        self.c_index = (self.c_index + num_previews) % num_images
        return None

    def process_previews(self, image_tensor, ind, leng):
        max_size = 512
        min_size = 256

        image_tensor = self.decode_latent_to_preview(image_tensor)

        if image_tensor.size(1) < min_size or image_tensor.size(2) < min_size:
            image_tensor = F.interpolate(
                image_tensor.movedim(-1, 0), scale_factor=4, mode='nearest'
            ).movedim(0, -1)

        if image_tensor.size(1) > max_size or image_tensor.size(2) > max_size:
            image_tensor = image_tensor.movedim(-1, 0)
            if image_tensor.size(2) < image_tensor.size(3):
                height = (max_size * image_tensor.size(2)) // image_tensor.size(3)
                image_tensor = F.interpolate(image_tensor, (height, max_size), mode='nearest')
            else:
                width = (max_size * image_tensor.size(3)) // image_tensor.size(2)
                image_tensor = F.interpolate(image_tensor, (max_size, width), mode='nearest')
            image_tensor = image_tensor.movedim(0, -1)

        previews_ubyte = (image_tensor.clamp(0, 1).mul(0xFF)).to(device="cpu", dtype=torch.uint8)

        server = _get_preview_server()
        if server is None:
            return

        for preview in previews_ubyte:
            try:
                i = Image.fromarray(preview.numpy())
                message = BytesIO()
                message.write((1).to_bytes(length=4, byteorder='big') * 2)
                message.write(ind.to_bytes(length=4, byteorder='big'))
                node_id = getattr(server, 'last_node_id', None) or ""
                message.write(struct.pack('16p', node_id.encode('ascii')))
                i.save(message, format="JPEG", quality=95, compress_level=1)

                from server import BinaryEventTypes
                server.send_sync(BinaryEventTypes.PREVIEW_IMAGE, message.getvalue(), server.client_id)

                if self.taeltx_vae is not None:
                    ind = (ind + 1) % ((leng - 1) * 8 + 1)
                else:
                    ind = (ind + 1) % leng
            except Exception:
                pass

    def decode_latent_to_preview(self, x0):
        if self.taeltx_vae is not None:
            dtype = self.taeltx_vae.first_stage_model.decoder[1].weight.dtype
            x0 = x0.unsqueeze(0).to(dtype=dtype, device=self.device)
            x_sample = self.taeltx_vae.first_stage_model.decode(x0)[0].permute(1, 2, 3, 0)
            return x_sample
        else:
            self.latent_rgb_factors = self.latent_rgb_factors.to(dtype=x0.dtype, device=x0.device)
            if self.latent_rgb_factors_bias is not None:
                self.latent_rgb_factors_bias = self.latent_rgb_factors_bias.to(dtype=x0.dtype, device=x0.device)

            latent_image = F.linear(
                x0.movedim(1, -1),
                self.latent_rgb_factors,
                self.latent_rgb_factors_bias
            )
            return latent_image.movedim(-1, 0)


class GJJ_OuterSampleCallbackWrapper:
    """包装采样器执行器以在采样过程中生成预览。"""

    def __init__(self, latent_upscale_model=None, vae=None, preview_rate=8, taeltx_mode=False):
        self.latent_upscale_model = latent_upscale_model
        self.vae = vae
        self.preview_rate = preview_rate
        self.taeltx_mode = taeltx_mode
        self.x0_output = {}
        self.device = mm.get_torch_device()

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes):
        try:
            guider = executor.class_obj
            diffusion_model = guider.model_patcher.model.diffusion_model
            is_23 = not diffusion_model.caption_projection_first_linear
        except Exception:
            is_23 = True

        original_callback = callback

        if self.latent_upscale_model is not None:
            try:
                self.latent_upscale_model.to(self.device)
            except Exception:
                pass

        if self.vae is not None and self.taeltx_mode:
            try:
                self.vae.first_stage_model.to(self.device)
            except Exception:
                pass

        num_keyframes = 0
        try:
            if hasattr(guider, 'conds') and 'positive' in guider.conds and len(guider.conds['positive']) > 0:
                keyframe_idxs = guider.conds['positive'][0].get('keyframe_idxs')
                if keyframe_idxs is not None:
                    num_keyframes = len(torch.unique(keyframe_idxs[0, 0, :, 0]))
        except Exception:
            pass

        new_callback = self._prepare_callback(
            len(sigmas) - 1,
            shape=latent_shapes[0] if len(latent_shapes) > 1 else None,
            num_keyframes=num_keyframes,
            is_23=is_23
        )

        def combined_callback(step, x0, x, total_steps):
            try:
                new_callback(step, x0, x, total_steps)
            except Exception:
                pass
            if original_callback is not None:
                try:
                    original_callback(step, x0, x, total_steps)
                except Exception:
                    pass

        out = executor(noise, latent_image, sampler, sigmas, denoise_mask, combined_callback, disable_pbar, seed, latent_shapes=latent_shapes)

        if self.latent_upscale_model is not None:
            try:
                self.latent_upscale_model.to(mm.unet_offload_device())
            except Exception:
                pass

        return out

    def _prepare_callback(self, steps, shape=None, num_keyframes=0, is_23=False):
        if not is_23:
            latent_rgb_factors = [
                [0.0350, 0.0159, 0.0132], [0.0025, -0.0021, -0.0003], [0.0286, 0.0028, 0.0020],
                [0.0280, -0.0114, -0.0202], [-0.0186, 0.0073, 0.0092], [0.0027, 0.0097, -0.0113],
                [-0.0069, -0.0032, -0.0024], [-0.0323, -0.0370, -0.0457], [0.0174, 0.0164, 0.0106],
                [-0.0097, 0.0061, 0.0035], [-0.0130, -0.0042, -0.0012], [-0.0102, -0.0002, -0.0091],
                [-0.0025, 0.0063, 0.0161], [0.0003, 0.0037, 0.0108], [0.0152, 0.0082, 0.0143],
                [0.0317, 0.0203, 0.0312], [-0.0092, -0.0233, -0.0119], [-0.0405, -0.0226, -0.0023],
                [0.0376, 0.0397, 0.0352], [0.0171, -0.0043, -0.0095], [0.0482, 0.0341, 0.0213],
                [0.0031, -0.0046, -0.0018], [-0.0486, -0.0383, -0.0294], [-0.0071, -0.0272, -0.0123],
                [0.0320, 0.0218, 0.0289], [0.0327, 0.0088, -0.0116], [-0.0098, -0.0240, -0.0111],
                [0.0094, -0.0116, 0.0021], [0.0309, 0.0092, 0.0165], [-0.0065, -0.0077, -0.0107],
                [0.0179, 0.0114, 0.0038], [-0.0018, -0.0030, -0.0026], [-0.0002, 0.0076, -0.0029],
                [-0.0131, -0.0059, -0.0170], [0.0055, 0.0066, -0.0038], [0.0154, 0.0063, 0.0090],
                [0.0186, 0.0175, 0.0188], [-0.0166, -0.0381, -0.0428], [0.0121, 0.0015, -0.0153],
                [0.0118, 0.0050, 0.0019], [0.0125, 0.0259, 0.0231], [0.0046, 0.0130, 0.0081],
                [0.0271, 0.0250, 0.0250], [-0.0054, -0.0347, -0.0326], [-0.0438, -0.0262, -0.0228],
                [-0.0191, -0.0256, -0.0173], [-0.0205, -0.0058, 0.0042], [0.0404, 0.0434, 0.0346],
                [-0.0242, -0.0177, -0.0146], [0.0161, 0.0223, 0.0168], [-0.0240, -0.0320, -0.0299],
                [-0.0019, 0.0043, 0.0008], [-0.0060, -0.0133, -0.0244], [-0.0048, -0.0225, -0.0167],
                [0.0267, 0.0133, 0.0152], [0.0222, 0.0167, 0.0028], [0.0015, -0.0062, 0.0013],
                [-0.0241, -0.0178, -0.0079], [0.0040, -0.0081, -0.0097], [-0.0064, 0.0133, -0.0011],
                [-0.0204, -0.0231, -0.0304], [0.0011, -0.0011, 0.0145], [-0.0283, -0.0259, -0.0260],
                [0.0038, 0.0171, -0.0029], [0.0637, 0.0424, 0.0409], [0.0092, 0.0163, 0.0188],
                [0.0082, 0.0055, -0.0179], [-0.0177, -0.0286, -0.0147], [0.0171, 0.0242, 0.0398],
                [-0.0129, 0.0095, -0.0071], [-0.0154, 0.0036, 0.0128], [-0.0081, -0.0009, 0.0118],
                [-0.0067, -0.0178, -0.0230], [-0.0022, -0.0125, -0.0003], [-0.0032, -0.0039, -0.0022],
                [-0.0005, -0.0127, -0.0131], [-0.0143, -0.0157, -0.0165], [-0.0262, -0.0263, -0.0270],
                [0.0063, 0.0127, 0.0178], [0.0092, 0.0133, 0.0150], [-0.0106, -0.0068, 0.0032],
                [-0.0214, -0.0022, 0.0171], [-0.0104, -0.0266, -0.0362], [0.0021, 0.0048, -0.0005],
                [0.0345, 0.0431, 0.0402], [-0.0275, -0.0110, -0.0195], [0.0203, 0.0251, 0.0224],
                [0.0016, -0.0037, -0.0094], [0.0241, 0.0198, 0.0114], [-0.0003, 0.0027, 0.0141],
                [0.0012, -0.0052, -0.0084], [0.0057, -0.0028, -0.0163], [-0.0488, -0.0545, -0.0509],
                [-0.0076, -0.0025, -0.0014], [-0.0249, -0.0142, -0.0367], [0.0136, 0.0041, 0.0135],
                [0.0007, 0.0034, -0.0053], [-0.0068, -0.0109, 0.0029], [0.0006, -0.0237, -0.0094],
                [-0.0149, -0.0177, -0.0131], [-0.0105, 0.0039, 0.0216], [0.0242, 0.0200, 0.0180],
                [-0.0339, -0.0153, -0.0195], [0.0104, 0.0151, 0.0120], [-0.0043, 0.0089, 0.0047],
                [0.0157, -0.0030, 0.0008], [0.0126, 0.0102, -0.0040], [0.0040, 0.0114, 0.0137],
                [0.0423, 0.0473, 0.0436], [-0.0128, -0.0066, -0.0152], [-0.0337, -0.0087, -0.0026],
                [-0.0052, 0.0235, 0.0291], [0.0079, 0.0154, 0.0260], [-0.0539, -0.0377, -0.0358],
                [-0.0188, 0.0062, -0.0035], [-0.0186, 0.0041, -0.0083], [0.0045, -0.0049, 0.0053],
                [0.0172, 0.0071, 0.0042], [-0.0003, -0.0078, -0.0096], [-0.0209, -0.0132, -0.0135],
                [-0.0074, 0.0017, 0.0099], [-0.0038, 0.0070, 0.0014], [-0.0013, -0.0017, 0.0073],
                [0.0030, 0.0105, 0.0105], [0.0154, -0.0168, -0.0235], [-0.0108, -0.0038, 0.0047],
                [-0.0298, -0.0347, -0.0436], [-0.0206, -0.0189, -0.0139]
            ]
            latent_rgb_factors_bias = [0.2796, 0.1101, -0.0047]
        else:
            latent_rgb_factors = [
                [0.002269406570121646, -0.02110900916159153, -0.009850316680967808],
                [-0.016038373112678528, -0.012462412007153034, -0.01112896017730236],
                [0.025274179875850677, 0.011209743097424507, 0.025426799431443214],
                [0.04690725728869438, 0.041542328894138336, 0.03568895906209946],
                [-0.02388044260442257, -0.0018645941745489836, 0.01858334057033062],
                [0.03720448538661003, 0.0220357533544302, 0.027937663719058037],
                [-0.07273884862661362, -0.09326262027025223, -0.11579664051532745],
                [-0.063837431371212, 0.00026216846890747547, 0.03042735904455185],
                [0.02903873845934868, 0.042082373052835464, 0.030649805441498756],
                [0.03777873516082764, 0.0322984978556633, -0.005671461578458548],
                [-0.0075670829974114895, -0.012113905511796474, -0.01638956367969513],
                [0.026524530723690987, 0.060518112033605576, 0.059549521654844284],
                [0.10093028098344803, 0.10073262453079224, 0.0505094900727272],
                [0.03725508227944374, 0.015382086858153343, 0.005786076188087463],
                [-0.03139607608318329, -0.01690264232456684, -0.0013519978383556008],
                [-0.027200624346733093, -0.02517341822385788, -0.008874989114701748],
                [0.024963486939668655, 0.04293748363852501, 0.05582639202475548],
                [-0.0364827960729599, -0.026975594460964203, -0.021950015798211098],
                [0.027655167505145073, 0.025136707350611687, 0.043967027217149734],
                [0.035822272300720215, 0.013104500249028206, 0.01113432738929987],
                [0.05353763327002525, 0.013606574386358261, -0.018720127642154694],
                [-0.013587888330221176, -0.01689346879720688, -0.027842802926898003],
                [0.059415675699710846, 0.03734271228313446, 0.04562298208475113],
                [-0.02946414425969124, -0.038338612765073776, 0.001805233070626855],
                [0.03921474143862724, 0.0651894062757492, 0.10681862384080887],
                [-0.00744189927354455, 0.007951526902616024, 0.020728807896375656],
                [-0.04038553684949875, -0.05215264856815338, -0.07213657349348068],
                [-0.004655141849070787, 0.01305423304438591, 0.026104029268026352],
                [0.03434251993894577, 0.018448110669851303, 0.013096392154693604],
            ]
            latent_rgb_factors_bias = [-0.6957847476005554, -0.7276281118392944, -0.7405748963356018]

        previewer = GJJ_WrappedPreviewer(
            latent_rgb_factors,
            latent_rgb_factors_bias,
            rate=self.preview_rate,
            taeltx_vae=self.vae if self.taeltx_mode else None
        )

        pbar = comfy.utils.ProgressBar(steps)

        def callback(step, x0, x, total_steps):
            try:
                if x0 is not None and shape is not None:
                    cut = math.prod(shape[1:])
                    x0 = x0[:, :, :cut].reshape([x0.shape[0]] + list(shape)[1:])

                if num_keyframes > 0:
                    x0 = x0[:, :, :-num_keyframes]

                if self.latent_upscale_model is not None and self.vae is not None:
                    try:
                        x0 = self.vae.first_stage_model.per_channel_statistics.un_normalize(x0)
                        x0 = self.latent_upscale_model(x0.to(torch.bfloat16))
                        x0 = self.vae.first_stage_model.per_channel_statistics.normalize(x0)
                    except Exception:
                        pass

                preview_bytes = None
                if previewer:
                    preview_bytes = previewer.decode_latent_to_preview_image("JPEG", x0)

                pbar.update_absolute(step + 1, total_steps, preview_bytes)
            except Exception:
                pass

        return callback


class GJJ_LTX2SamplingPreviewOverride:
    """
    LTX2 采样预览覆盖节点。

    覆盖 LTX2 模型的采样预览功能，在采样过程中生成实时预览图像。
    这是临时措施，直到预览功能集成到 ComfyUI 核心。

    特性：
    - 在采样过程中显示实时预览
    - 可调节预览帧率
    - 支持可选的 latent 上采样模型以获得更高分辨率预览
    - 支持 TAEHV VAE（LTX2.3 模型）
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL", {"display_name": "模型", "tooltip": "要添加预览覆盖的模型"}),
                "preview_rate": ("INT", {"default": 8, "min": 1, "max": 60, "step": 1,
                                        "display_name": "预览帧率", "tooltip": "预览图像生成帧率（每秒预览数）"}),
            },
            "optional": {
                "latent_upscale_model": ("LATENT_UPSCALE_MODEL", {"display_name": "Latent 上采样模型", "tooltip": "用于更高分辨率预览的可选上采样模型"}),
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "用于为上采样模型归一化 latent 的 VAE 模型"}),
                "bypass": ("BOOLEAN", {"default": False, "display_name": "跳过处理",
                                        "tooltip": "启用后直接返回原始模型，不添加预览覆盖"}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    OUTPUT_TOOLTIPS = ("添加了采样预览覆盖的模型",)
    CATEGORY = "GJJ/采样"
    FUNCTION = "generate"
    DESCRIPTION = "LTX2 采样预览覆盖。覆盖 LTX2 模型的采样预览功能，在采样过程中生成实时预览图像。"

    def generate(self, model, preview_rate=8, latent_upscale_model=None, vae=None, bypass=False):
        """
        为模型添加采样预览覆盖。

        参数：
            model: 要修改的模型
            preview_rate: 预览帧率
            latent_upscale_model: 可选的上采样模型
            vae: 可选的 VAE
            bypass: 是否跳过

        返回：
            修改后的模型
        """
        if bypass:
            return (model,)

        try:
            cloned_model = model.clone()
        except Exception:
            return (model,)

        taeltx_mode = False
        if vae is not None:
            try:
                vae_class_name = vae.first_stage_model.__class__.__name__
                if vae_class_name == "TAEHV":
                    taeltx_mode = True
                    latent_upscale_model = None
            except Exception:
                pass

        try:
            wrapper = GJJ_OuterSampleCallbackWrapper(
                latent_upscale_model=latent_upscale_model,
                vae=vae,
                preview_rate=preview_rate,
                taeltx_mode=taeltx_mode
            )

            cloned_model.add_wrapper_with_key(
                comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
                "sampling_preview",
                wrapper
            )
        except AttributeError:
            print("[GJJ] 警告: 无法访问 ComfyUI 内部 API (comfy.patcher_extension.WrappersMP.OUTER_SAMPLE)。预览功能不可用。")
            return (model,)
        except Exception as e:
            print(f"[GJJ] 警告: 添加采样预览包装器时出错: {e}")
            return (model,)

        return (cloned_model,)


NODE_CLASS_MAPPINGS["GJJ_LTX2SamplingPreviewOverride"] = GJJ_LTX2SamplingPreviewOverride
NODE_DISPLAY_NAME_MAPPINGS["GJJ_LTX2SamplingPreviewOverride"] = "🎬 LTX2 采样预览覆盖"

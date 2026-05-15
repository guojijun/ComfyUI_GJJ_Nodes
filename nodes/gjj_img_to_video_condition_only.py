import torch
import comfy
import folder_paths

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class GJJ_ImgToVideoConditionOnly:
    """
    将图像条件应用到视频 latent 的前几帧。
    
    特性：
    - 接收已有的 latent 并应用图像条件
    - 自动调整图像大小以匹配 latent 维度
    - 创建 noise mask 用于控制条件强度
    - 支持 bypass 模式跳过处理
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "vae": ("VAE", {"display_name": "VAE", "tooltip": "用于编码图像的 VAE 模型"}),
                "image": ("IMAGE", {"display_name": "图像", "tooltip": "作为条件的输入图像"}),
                "latent": ("LATENT", {"display_name": "视频 Latent", "tooltip": "要应用条件的视频 latent（必须是 5D 张量）"}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                      "display_name": "强度", "tooltip": "条件强度，0 表示无影响，1 表示完全应用"}),
            },
            "optional": {
                "bypass": ("BOOLEAN", {"default": False, "display_name": "跳过处理",
                                       "tooltip": "启用后直接返回原始 latent，不应用任何条件"}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("视频 Latent",)
    OUTPUT_TOOLTIPS = ("应用了图像条件的视频 latent",)
    CATEGORY = "GJJ/视频"
    FUNCTION = "generate"
    DESCRIPTION = "将图像条件应用到视频 latent 的前几帧。创建 noise mask 来控制条件强度。"

    def encode_image(self, image, shape, vae):
        """
        将图像编码为 latent 格式。
        
        参数：
            image: 输入图像张量
            shape: 目标 latent 的形状 (batch, channels, frames, height, width)
            vae: VAE 模型
        
        返回：
            编码后的 latent 张量
        """
        time_scale_factor, height_scale_factor, width_scale_factor = vae.downscale_index_formula
        batch, channels, frames, height, width = shape
        
        # 计算目标尺寸（latent 尺寸 × 缩放因子）
        target_width = width * width_scale_factor
        target_height = height * height_scale_factor

        # 调整图像大小以匹配 latent 维度
        if image.shape[1] != target_height or image.shape[2] != target_width:
            pixels = comfy.utils.common_upscale(
                image.movedim(-1, 1), target_width, target_height, "bilinear", "center"
            ).movedim(1, -1)
        else:
            pixels = image

        # 只编码 RGB 通道
        encode_pixels = pixels[:, :, :, :3]
        encoded_latent = vae.encode(encode_pixels)
        
        return encoded_latent

    def generate(self, vae, image, latent, strength=1.0, bypass=False):
        """
        执行图像到视频条件的转换。
        
        参数：
            vae: VAE 模型
            image: 输入图像
            latent: 视频 latent
            strength: 条件强度
            bypass: 是否跳过处理
        
        返回：
            应用了条件的 latent
        """
        if bypass:
            return (latent,)

        samples = latent["samples"]
        
        # 编码图像
        encoded_image = self.encode_image(image, samples.shape, vae)
        
        # 将编码后的图像应用到视频 latent 的前几帧
        samples[:, :, :encoded_image.shape[2]] = encoded_image

        # 创建 noise mask 用于条件控制
        batch_size = samples.shape[0]
        num_frames = samples.shape[2]
        
        conditioning_mask = torch.ones(
            (batch_size, 1, num_frames, 1, 1),
            dtype=torch.float32,
            device=samples.device,
        )
        
        # 在应用条件的帧上设置 mask 值
        conditioning_mask[:, :, :encoded_image.shape[2]] = 1.0 - strength

        return ({
            "samples": samples,
            "noise_mask": conditioning_mask
        },)


NODE_CLASS_MAPPINGS["GJJ_ImgToVideoConditionOnly"] = GJJ_ImgToVideoConditionOnly
NODE_DISPLAY_NAME_MAPPINGS["GJJ_ImgToVideoConditionOnly"] = "🎬 图像转视频条件"

from __future__ import annotations

from nodes import PreviewImage


NODE_NAME = "GJJ_ImageComparer"


def _image_dimensions(image):
    shape = getattr(image, "shape", None)
    if not shape:
        return []

    try:
        if len(shape) == 4:
            batch = int(shape[0])
            height = int(shape[1])
            width = int(shape[2])
            return [{"width": width, "height": height} for _ in range(batch)]
        if len(shape) == 3:
            height = int(shape[0])
            width = int(shape[1])
            return [{"width": width, "height": height}]
    except Exception:
        return []
    return []


def _attach_dimensions(saved, image):
    images = saved.get("ui", {}).get("images", [])
    for item, dims in zip(images, _image_dimensions(image)):
        item.update(dims)
    return images


class GJJ_ImageComparer(PreviewImage):
    CATEGORY = "GJJ"
    FUNCTION = "compare_images"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    DESCRIPTION = "对比两路图片，使用简单滑动分割线查看差异。"
    SEARCH_ALIASES = [
        "image compare",
        "image comparer",
        "图片对比",
        "对比图",
        "slider compare",
        "before after",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image_a": (
                    "IMAGE",
                    {
                        "display_name": "图片 A",
                        "tooltip": "第一路图片输入；建议接单张图，也支持批量图。",
                    },
                ),
                "image_b": (
                    "IMAGE",
                    {
                        "display_name": "图片 B",
                        "tooltip": "第二路图片输入；建议接单张图，也支持批量图。",
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def compare_images(
        self,
        image_a=None,
        image_b=None,
        prompt=None,
        extra_pnginfo=None,
    ):
        result = {
            "ui": {
                "a_images": [],
                "b_images": [],
            }
        }

        if image_a is not None and len(image_a) > 0:
            saved = self.save_images(image_a, "gjj.compare.a", prompt, extra_pnginfo)
            result["ui"]["a_images"] = _attach_dimensions(saved, image_a)

        if image_b is not None and len(image_b) > 0:
            saved = self.save_images(image_b, "gjj.compare.b", prompt, extra_pnginfo)
            result["ui"]["b_images"] = _attach_dimensions(saved, image_b)

        return result


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_ImageComparer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🆚 图片对比比较"}

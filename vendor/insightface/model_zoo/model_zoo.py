# -*- coding: utf-8 -*-
# @Organization  : insightface.ai
# @Author        : Jia Guo
# @Time          : 2021-05-04
# @Function      : 

import os
import os.path as osp
import glob
import onnxruntime
from .arcface_onnx import *
from .scrfd import *
from .inswapper import INSwapper

#__all__ = ['get_model', 'get_model_list', 'get_arcface_onnx', 'get_scrfd']
__all__ = ['get_model']


class ModelRouter:
    def __init__(self, onnx_file):
        self.onnx_file = onnx_file

    def get_model(self):
        try:
            print(f"[GJJ ModelRouter] 🔍 开始加载模型: {self.onnx_file}")
            
            session = onnxruntime.InferenceSession(self.onnx_file, None)
            input_cfg = session.get_inputs()[0]
            input_shape = input_cfg.shape
            outputs = session.get_outputs()
            inputs = session.get_inputs()
            
            print(f"[GJJ ModelRouter] 📊 输入数量: {len(inputs)}")
            print(f"[GJJ ModelRouter]  输入形状: {input_shape}")
            print(f"[GJJ ModelRouter] 📊 输出数量: {len(outputs)}")
            print(f"[GJJ ModelRouter] 📊 输出形状: {[o.shape for o in outputs]}")
            
            # 判断模型类型
            if len(inputs) == 2 and input_shape[2] == 128 and input_shape[3] == 128:
                # INSwapper 换脸模型（2个输入，128x128）
                print(f"[GJJ ModelRouter] ✅ 识别为 INSwapper 换脸模型 (输入数量: 2, 尺寸: 128x128)")
                return INSwapper(model_file=self.onnx_file, session=session)
            elif len(outputs) >= 5:
                # SCRFD 人脸检测模型（输出数量 >= 5）
                print(f"[GJJ ModelRouter] ✅ 识别为 SCRFD 检测模型 (输出数量: {len(outputs)} >= 5)")
                return SCRFD(model_file=self.onnx_file, session=session)
            elif input_shape[2] is not None and input_shape[3] is not None:
                # ArcFace 人脸识别模型（需要明确的输入尺寸）
                h, w = input_shape[2], input_shape[3]
                print(f"[GJJ ModelRouter] 📐 识别为 ArcFace 识别模型 (输入尺寸: {h}x{w})")
                return ArcFaceONNX(model_file=self.onnx_file, session=session)
            else:
                # 无法识别的模型
                error_msg = f"无法识别模型类型\n"
                error_msg += f"  文件: {self.onnx_file}\n"
                error_msg += f"  输入数量: {len(inputs)}\n"
                error_msg += f"  输入形状: {input_shape}\n"
                error_msg += f"  输出数量: {len(outputs)}\n"
                error_msg += f"  输出形状: {[o.shape for o in outputs]}\n"
                error_msg += f"  判断条件:\n"
                error_msg += f"    - len(inputs)==2 and 128x128: {len(inputs) == 2 and input_shape[2] == 128 and input_shape[3] == 128}\n"
                error_msg += f"    - len(outputs) >= 5: {len(outputs) >= 5} (实际: {len(outputs)})\n"
                error_msg += f"    - 输入尺寸明确: {input_shape[2] is not None and input_shape[3] is not None}\n"
                print(f"[GJJ ModelRouter] ️  跳过非标准模型: {error_msg}")
                
                # 返回 None 表示跳过此模型（不要抛出异常）
                return None
        except Exception as e:
            print(f"[GJJ ModelRouter]  模型加载失败: {e}")
            import traceback
            print(f"[GJJ ModelRouter]  详细堆栈:\n{traceback.format_exc()}")
            # 返回 None 而不是抛出异常，允许其他模型继续加载
            return None


def find_onnx_file(dir_path):
    if not os.path.exists(dir_path):
        return None
    paths = glob.glob("%s/*.onnx" % dir_path)
    if len(paths) == 0:
        return None
    paths = sorted(paths)
    return paths[-1]

def get_model(name, **kwargs):
    root = kwargs.get('root', '~/.insightface/models')
    root = os.path.expanduser(root)
    if not name.endswith('.onnx'):
        model_dir = os.path.join(root, name)
        model_file = find_onnx_file(model_dir)
        if model_file is None:
            return None
    else:
        model_file = name
    assert osp.isfile(model_file), 'model should be file'
    router = ModelRouter(model_file)
    model = router.get_model()
    #print('get-model for ', name,' : ', model.taskname)
    return model


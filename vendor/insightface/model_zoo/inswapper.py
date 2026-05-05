# @Organization  : insightface.ai
# @Author        : Jia Guo
# @Time          : 2021-05-04
# @Function      : 

import cv2
import onnx
import onnxruntime
import numpy as np
from onnx import numpy_helper
from skimage import transform as trans


__all__ = ['INSwapper']


class INSwapper():
    def __init__(self, model_file=None, session=None):
        self.model_file = model_file
        self.session = session
        model = onnx.load(self.model_file)
        graph = model.graph
        self.emap = numpy_helper.to_array(graph.initializer[-1])
        self.input_mean = 0.0
        self.input_std = 255.0
        if self.session is None:
            self.session = onnxruntime.InferenceSession(self.model_file, None)
        inputs = self.session.get_inputs()
        self.input_names = []
        for inp in inputs:
            self.input_names.append(inp.name)
        outputs = self.session.get_outputs()
        output_names = []
        for out in outputs:
            output_names.append(out.name)
        self.output_names = output_names
        assert len(self.output_names)==1
        output_shape = outputs[0].shape
        input_cfg = inputs[0]
        input_shape = input_cfg.shape
        self.input_shape = input_shape
        print('inswapper-shape:', self.input_shape)
        self.input_size = tuple(input_shape[2:4][::-1])

    def prepare(self, ctx_id, **kwargs):
        if ctx_id<0:
            self.session.set_providers(['CPUExecutionProvider'])

    def get(self, img, target_face, source_face, paste_back=True):
        aimg, M = self.get_input(img, target_face)
        blob = cv2.dnn.blobFromImage(aimg, 1.0/self.input_std, self.input_size,
                                      (self.input_mean, self.input_mean, self.input_mean), swapRB=True)
        latent = source_face.normed_embedding.reshape((1,-1))
        latent = np.dot(latent, self.emap)
        latent /= np.linalg.norm(latent)
        pred = self.session.run(self.output_names, {self.input_names[0]: blob, self.input_names[1]: latent})[0]
        img_fake = pred.transpose((0,2,3,1))[0]
        bgr_fake = np.clip(255 * img_fake, 0, 255).astype(np.uint8)[:,:,::-1]
        if not paste_back:
            return bgr_fake, M
        else:
            target_img = img
            fake_diff = bgr_fake.astype(np.float32) - aimg.astype(np.float32)
            fake_diff = np.abs(fake_diff).mean(axis=2)
            fake_diff[:2,:] = 0
            fake_diff[-2:,:] = 0
            fake_diff[:,:2] = 0
            fake_diff[:,-2:] = 0
            IM = cv2.invertAffineTransform(M)
            img_white = np.full((aimg.shape[0],aimg.shape[1]), 255, dtype=np.float32)
            bgr_fake = cv2.warpAffine(bgr_fake, IM, (target_img.shape[1], target_img.shape[0]), borderValue=0.0)
            img_white = cv2.warpAffine(img_white, IM, (target_img.shape[1], target_img.shape[0]), borderValue=0.0)
            fake_diff = cv2.warpAffine(fake_diff, IM, (target_img.shape[1], target_img.shape[0]), borderValue=0.0)
            img_white[img_white>20] = 255
            fthresh = 10
            fake_diff[fake_diff<fthresh] = 0
            fake_diff[fake_diff>=fthresh] = 255
            img_mask = img_white
            mask_h_inds, mask_w_inds = np.where(img_mask==255)
            mask_h = np.max(mask_h_inds) - np.min(mask_h_inds)
            mask_w = np.max(mask_w_inds) - np.min(mask_w_inds)
            mask_size = int(np.sqrt(mask_h*mask_w))
            k = max(mask_size//10, 10)
            kernel = np.ones((k,k),np.uint8)
            img_mask = cv2.erode(img_mask,kernel,iterations = 1)
            kernel = np.ones((2,2),np.uint8)
            fake_diff = cv2.dilate(fake_diff,kernel,iterations = 1)
            k = max(mask_size//20, 5)
            kernel_size = (k, k)
            blur_size = tuple(2*i+1 for i in kernel_size)
            img_mask = cv2.GaussianBlur(img_mask, blur_size, 0)
            k = 5
            kernel_size = (k, k)
            blur_size = tuple(2*i+1 for i in kernel_size)
            fake_diff = cv2.blur(fake_diff, (11,11), 0)
            img_mask /= 255
            fake_diff /= 255
            img_mask = np.reshape(img_mask, [img_mask.shape[0],img_mask.shape[1],1])
            fake_merged = img_mask * bgr_fake + (1-img_mask) * target_img.astype(np.float32)
            fake_merged = fake_merged.astype(np.uint8)
            return fake_merged

    def get_input(self, img, target_face):
        M, _ = self.get_affine_matrix(target_face)
        aimg = cv2.warpAffine(img, M, self.input_size, borderValue=0.0)
        return aimg, M

    def get_affine_matrix(self, target_face):
        # 使用官方 insightface 的估计方法
        # 参考: vendor/insightface/utils/face_align.py 中的 estimate_norm 函数
        
        # 兼容 kps 和 landmark 两种字段名
        landmark_data = None
        if hasattr(target_face, 'kps') and target_face.kps is not None:
            landmark_data = target_face.kps
        elif hasattr(target_face, 'landmark') and target_face.landmark is not None:
            landmark_data = target_face.landmark
        
        if landmark_data is None:
            raise ValueError("Face object has no landmark data (kps or landmark)")
        
        # 确保 landmark 是正确的形状 (5, 2)
        landmark = np.array(landmark_data, dtype=np.float32)
        if landmark.shape != (5, 2):
            raise ValueError(f"landmark shape must be (5, 2), but got {landmark.shape}")
        
        # 标准模板（112x112）
        arcface_src = np.array([
            [38.2946, 51.6963],
            [73.5318, 51.5014],
            [56.0252, 71.7366],
            [41.5493, 92.3655],
            [70.7299, 92.2041]
        ], dtype=np.float32)
        
        # 缩放到 128x128（inswapper 需要）
        scale_factor = 128.0 / 112.0
        src = arcface_src * scale_factor
        
        # 估计相似变换
        tform = trans.SimilarityTransform()
        tform.estimate(landmark, src)
        
        M = tform.params[0:2, :]
        return M, tform

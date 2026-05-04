import os, sys, math, shutil, subprocess, tempfile, uuid 
import numpy as np, torch, torchvision, cv2 
from torchvision import transforms 
import tqdm, soundfile as sf 
from omegaconf import OmegaConf 
from einops import rearrange 
import folder_paths 
from diffusers import AutoencoderKL, DDIMScheduler 
from accelerate.utils import set_seed 
_NODE_DIR = os.path.dirname(os.path.abspath(__file__)) 
if _NODE_DIR not in sys.path: sys.path.insert(0,_NODE_DIR) 
 
from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline 
from latentsync.utils.image_processor import ImageProcessor, load_fixed_mask 
from latentsync.utils.util import read_video, read_audio, write_video, check_ffmpeg_installed 
from latentsync.models.unet import UNet3DConditionModel 
from latentsync.whisper.audio2feature import Audio2Feature 
def _find_latentsync_checkpoints(): 
    latentsync_dir = os.path.join(folder_paths.models_dir, 'latentsync') 
    if os.path.isdir(latentsync_dir): 
        required = ['latentsync_unet.pt', 'vae/config.json', 'whisper/tiny.pt'] 
        missing = [f for f in required if not os.path.exists(os.path.join(latentsync_dir, f))] 
        if not missing: return latentsync_dir 
    for ckpt_dir in folder_paths.get_folder_paths('checkpoints'): 
        candidate = os.path.join(ckpt_dir, 'LatentSync-1.6') 
        if os.path.isdir(candidate): return candidate 
    raise FileNotFoundError('LatentSync models not found') 
 
class EnhancedLipsyncPipeline(LipsyncPipeline): 
    def _safe_affine_transform_segment(self, video_frames): 
        faces=[]; boxes=[]; matrices=[]; no_face_indices=[] 
        for i,frame in enumerate(tqdm.tqdm(video_frames,desc='Face detection',leave=False)): 
            try: 
                face,box,matrix = self.image_processor.affine_transform(frame) 
                faces.append(face); boxes.append(box); matrices.append(matrix) 
            except RuntimeError as e: 
                if 'Face not detected' in str(e): 
                    faces.append(None); boxes.append(None); matrices.append(None) 
                    no_face_indices.append(i) 
                else: raise 
        no_face_set = set(no_face_indices) 
        has_face = [i for i in range(len(video_frames)) if i not in no_face_set] 
        if not has_face: return None,None,None,no_face_set 
        for idx in no_face_indices: 
            nearest = min(has_face, key=lambda x: abs(x-idx)) 
            faces[idx]=faces[nearest]; boxes[idx]=boxes[nearest]; matrices[idx]=matrices[nearest] 
        return torch.stack(faces), boxes, matrices, no_face_set 
 
    def _restore_segment(self, synced_faces, original_frames, boxes, matrices, no_face_set): 
        out_frames = [] 
        for i, face in enumerate(tqdm.tqdm(synced_faces, desc='Restoring', leave=False)): 
            if i in no_face_set: 
                out_frames.append(original_frames[i]) 
                continue 
            x1,y1,x2,y2 = boxes[i] 
            h = int(y2-y1); w = int(x2-x1) 
            face = transforms.functional.resize(face, [h,w], interpolation=transforms.InterpolationMode.BICUBIC, antialias=True) 
            out_frame = self.image_processor.restorer.restore_img(original_frames[i], face, matrices[i]) 
            out_frames.append(out_frame) 
        return np.stack(out_frames, axis=0) 
 
    @staticmethod 
    def _loop_frames_only(video_frames, target_length): 
        if len(video_frames) >= target_length: return video_frames[:target_length]
        num_loops = math.ceil(target_length / len(video_frames)) 
        parts = [] 
        for i in range(num_loops): 
            if i % 2 == 0: parts.append(video_frames)
            else: parts.append(video_frames[::-1])
        return np.concatenate(parts, axis=0)[:target_length] 
 
class LatentSyncEnhancedNode: 
    def __init__(self): 
        self.pipeline = None 
 
    def inference(self, images, audio, seed=0, lips_expression=1.5, inference_steps=20, chunk_frames=80, video_fps=25): 
        ckpt_dir = _find_latentsync_checkpoints() 
        config_path = os.path.join(ckpt_dir, 'config.yaml') 
        if not os.path.exists(config_path): 
            config_path = os.path.join(_NODE_DIR, 'configs', 'lipsync.yaml') 
        config = OmegaConf.load(config_path) 
        sample_rate = config.data.get('sample_rate', 16000) 
        weight_dtype = torch.float16 
        temp_dir = tempfile.mkdtemp() 
        video_path = os.path.join(temp_dir, 'input_video.mp4') 
        audio_path = os.path.join(temp_dir, 'input_audio.wav') 
        import cv2 
        fourcc = cv2.VideoWriter_fourcc(*'mp4v') 
        h,w = images.shape[1:3] 
        out = cv2.VideoWriter(video_path, fourcc, video_fps, (w,h)) 
        for frame in images: 
            frame_np = (frame.clamp(0,1).cpu().numpy() * 255).astype(np.uint8) 
            out.write(cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)) 
        out.release() 
 
        audio_np = audio['waveform'].squeeze(0).cpu().numpy() 
        sf.write(audio_path, audio_np, sample_rate) 
 
        pipeline = self._load_pipeline(ckpt_dir, config, weight_dtype) 
        output_path = os.path.join(temp_dir, 'output_video.mp4') 
 
        torch.cuda.empty_cache() 
        set_seed(seed) 
        result = pipeline(
            video_path=video_path,
            audio_path=audio_path,
            video_out_path=output_path,
            num_frames=chunk_frames,
            video_fps=video_fps,
            num_inference_steps=inference_steps,
            guidance_scale=lips_expression,
            weight_dtype=weight_dtype,
        )
        if isinstance(result, tuple):
            output_video = result[0] 
            output_audio = result[1] 
        else: 
            output_video = result 
            output_audio = audio_path 
 
        cap = cv2.VideoCapture(output_video) 
        out_frames = [] 
        while True: 
            ret, frame = cap.read() 
            if not ret: break 
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB) 
            out_frames.append(torch.from_numpy(frame).float() / 255.0) 
        cap.release() 
        out_frames = torch.stack(out_frames) 
 
        audio_data, sr = sf.read(output_audio) 
        if len(audio_data.shape) == 1: 
            audio_data = np.stack([audio_data, audio_data], axis=1) 
        audio_tensor = torch.from_numpy(audio_data).float().unsqueeze(0) 
        return out_frames, {'waveform': audio_tensor, 'sample_rate': sr} 
 
    def _load_pipeline(self, ckpt_dir, config, weight_dtype): 
        noise_scheduler = DDIMScheduler.from_pretrained(ckpt_dir, subfolder='scheduler') 
        vae = AutoencoderKL.from_pretrained(os.path.join(ckpt_dir,'vae')) 
        if next(vae.parameters()).is_meta: 
            vae._device = 'cpu' 
            vae = vae.to_empty(device='cpu') 
        vae = vae.to(device='cuda', dtype=weight_dtype) 
        audio_encoder = Audio2Feature(model_path=os.path.join(ckpt_dir,'whisper','tiny.pt')) 
        unet = UNet3DConditionModel.from_pretrained( 
            config.unet_config, 
            os.path.join(ckpt_dir, 'latentsync_unet.pt'), 
            device='cuda', 
        ) 
        if next(unet.parameters()).is_meta: 
            unet = unet.to_empty(device='cuda') 
        unet = unet.to(dtype=weight_dtype) 
        pipeline = EnhancedLipsyncPipeline(
            vae=vae, 
            unet=unet, 
            audio_encoder=audio_encoder, 
            scheduler=noise_scheduler, 
        ) 
        for name, module in pipeline.named_children(): 
            try: 
                if next(module.parameters()).is_meta: 
                    module.to_empty(device='cuda') 
            except StopIteration: pass 
        return pipeline.to('cuda') 
 
NODE_CLASS_MAPPINGS = { 
    'LatentSyncEnhanced': LatentSyncEnhancedNode, 
} 
NODE_DISPLAY_NAME_MAPPINGS = { 
    'LatentSyncEnhanced': 'LatentSync Enhanced (No-Face Safe + OOM Guard)', 
} 

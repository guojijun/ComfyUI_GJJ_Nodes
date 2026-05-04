import os
import math
import os.path as osp
import random
import pickle
import warnings

import glob
import numpy as np
from PIL import Image

import torch
import torch.utils.data as data
import torch.nn.functional as F
import torch.distributed as dist
from torchvision.datasets.video_utils import VideoClips

IMG_EXTENSIONS = ['.jpg', '.JPG', '.jpeg', '.JPEG', '.png', '.PNG']
VID_EXTENSIONS = ['.avi', '.mp4', '.webm', '.mov', '.mkv', '.m4v']


def get_dataloader(data_path, image_folder, resolution=128, sequence_length=16, sample_every_n_frames=1,
                   batch_size=16, num_workers=8):
    data = VideoData(data_path, image_folder, resolution, sequence_length, sample_every_n_frames, batch_size, num_workers)
    loader = data._dataloader()
    return loader


def is_image_file(filename):
    return any(filename.endswith(extension) for extension in IMG_EXTENSIONS)


def get_parent_dir(path):
    return osp.basename(osp.dirname(path))


def preprocess(video, resolution, sequence_length=None, in_channels=3, sample_every_n_frames=1):
    # video: THWC, {0, ..., 255}
    assert in_channels == 3
    video = video.permute(0, 3, 1, 2).float() / 255.  # TCHW
    t, c, h, w = video.shape

    # temporal crop
    if sequence_length is not None:
        assert sequence_length <= t
        video = video[:sequence_length]

    # skip frames
    if sample_every_n_frames > 1:
        video = video[::sample_every_n_frames]

    # scale shorter side to resolution
    scale = resolution / min(h, w)
    if h < w:
        target_size = (resolution, math.ceil(w * scale))
    else:
        target_size = (math.ceil(h * scale), resolution)
    video = F.interpolate(video, size=target_size, mode='bilinear',
                          align_corners=False, antialias=True)

    # center crop
    t, c, h, w = video.shape
    w_start = (w - resolution) // 2
    h_start = (h - resolution) // 2
    video = video[:, :, h_start:h_start + resolution, w_start:w_start + resolution]
    video = video.permute(1, 0, 2, 3).contiguous()  # CTHW

    return {'video': video}


def preprocess_image(image):
    # [0, 1] => [-1, 1]
    img = torch.from_numpy(image)
    return img


class VideoData(data.Dataset):
    """ Class to create dataloaders for video datasets 

    Args:
        data_path: Path to the folder with video frames or videos.
        image_folder: If True, the data is stored as images in folders.
        resolution: Resolution of the returned videos.
        sequence_length: Length of extracted video sequences.
        sample_every_n_frames: Sample every n frames from the video.
        batch_size: Batch size.
        num_workers: Number of workers for the dataloader.
        shuffle: If True, shuffle the data.
    """

    def __init__(self, data_path: str, image_folder: bool, resolution: int, sequence_length: int,
                 sample_every_n_frames: int, batch_size: int, num_workers: int, shuffle: bool = True):
        super().__init__()
        self.data_path = data_path
        self.image_folder = image_folder
        self.resolution = resolution
        self.sequence_length = sequence_length
        self.sample_every_n_frames = sample_every_n_frames
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.shuffle = shuffle

    def _dataset(self):
        '''
        Initializes and return the dataset.
        '''
        if self.image_folder:
            Dataset = FrameDataset
            dataset = Dataset(self.data_path, self.sequence_length,
                                resolution=self.resolution, sample_every_n_frames=self.sample_every_n_frames)
        else:
            Dataset = VideoDataset
            dataset = Dataset(self.data_path, self.sequence_length,
                              resolution=self.resolution, sample_every_n_frames=self.sample_every_n_frames)
        return dataset

    def _dataloader(self):
        '''
        Initializes and returns the dataloader.
        '''
        dataset = self._dataset()
        if dist.is_initialized():
            sampler = data.distributed.DistributedSampler(
                dataset, num_replicas=dist.get_world_size(), rank=dist.get_rank()
            )
        else:
            sampler = None
        dataloader = data.DataLoader(
            dataset,
            batch_size=self.batch_size,
            num_workers=self.num_workers,
            pin_memory=True,
            sampler=sampler,
            shuffle=sampler is None and self.shuffle is True
        )
        return dataloader


class VideoDataset(data.Dataset):
    """ 
    Generic dataset for videos files stored in folders.
    Videos of the same class are expected to be stored in a single folder. Multiple folders can exist in the provided directory.
    The class depends on `torchvision.datasets.video_utils.VideoClips` to load the videos.
    Returns BCTHW videos in the range [0, 1].

    Args:
        data_folder: Path to the folder with corresponding videos stored.
        sequence_length: Length of extracted video sequences.
        resolution: Resolution of the returned videos.
        sample_every_n_frames: Sample every n frames from the video.
    """

    def __init__(self, data_folder: str, sequence_length: int = 16, resolution: int = 128, sample_every_n_frames: int = 1):
        super().__init__()
        self.sequence_length = sequence_length
        self.resolution = resolution
        self.sample_every_n_frames = sample_every_n_frames

        folder = data_folder
        files = sum([glob.glob(osp.join(folder, '**', f'*{ext}'), recursive=True)
                     for ext in VID_EXTENSIONS], [])
    
        warnings.filterwarnings('ignore')
        cache_file = osp.join(folder, f"metadata_{sequence_length}.pkl")
        if not osp.exists(cache_file):
            clips = VideoClips(files, sequence_length, num_workers=4)
            try:
                pickle.dump(clips.metadata, open(cache_file, 'wb'))
            except:
                print(f"Failed to save metadata to {cache_file}")
        else:
            metadata = pickle.load(open(cache_file, 'rb'))
            clips = VideoClips(files, sequence_length,
                               _precomputed_metadata=metadata)

        self._clips = clips
        # instead of uniformly sampling from all possible clips, we sample uniformly from all possible videos
        self._clips.get_clip_location = self.get_random_clip_from_video
        
    def get_random_clip_from_video(self, idx: int) -> tuple:
        '''
        Sample a random clip starting index from the video.

        Args:
            idx: Index of the video.
        '''
        # Note that some videos may not contain enough frames, we skip those videos here.
        while self._clips.clips[idx].shape[0] <= 0:
            idx += 1
        n_clip = self._clips.clips[idx].shape[0]
        clip_id = random.randint(0, n_clip - 1)
        return idx, clip_id

    def __len__(self):
        return self._clips.num_videos()

    def __getitem__(self, idx):
        resolution = self.resolution
        while True:
            try:
                video, _, _, idx = self._clips.get_clip(idx)
            except Exception as e:
                print(idx, e)
                idx = (idx + 1) % self._clips.num_clips()
                continue
            break

        return dict(**preprocess(video, resolution, sample_every_n_frames=self.sample_every_n_frames))


class FrameDataset(data.Dataset):
    """ 
    Generic dataset for videos stored as images. The loading will iterates over all the folders and subfolders
        in the provided directory. Each leaf folder is assumed to contain frames from a single video.

    Args:
        data_folder: path to the folder with video frames. The folder
            should contain folders with frames from each video.
        sequence_length: length of extracted video sequences
        resolution: resolution of the returned videos
        sample_every_n_frames: sample every n frames from the video
    """

    def __init__(self, data_folder, sequence_length, resolution=64, sample_every_n_frames=1):
        self.resolution = resolution
        self.sequence_length = sequence_length
        self.sample_every_n_frames = sample_every_n_frames
        self.data_all = self.load_video_frames(data_folder)
        self.video_num = len(self.data_all)

    def __getitem__(self, index):
        batch_data = self.getTensor(index)
        return_list = {'video': batch_data}

        return return_list

    def load_video_frames(self, dataroot: str) -> list:
        '''
        Loads all the video frames under the dataroot and returns a list of all the video frames.

        Args:
            dataroot: The root directory containing the video frames.

        Returns:
            A list of all the video frames.

        '''
        data_all = []
        frame_list = os.walk(dataroot)
        for _, meta in enumerate(frame_list):
            root = meta[0]
            try:
                frames = sorted(meta[2], key=lambda item: int(item.split('.')[0].split('_')[-1]))
            except:
                print(meta[0], meta[2])
            if len(frames) < max(0, self.sequence_length * self.sample_every_n_frames):
                continue
            frames = [
                os.path.join(root, item) for item in frames
                if is_image_file(item)
            ]
            if len(frames) > max(0, self.sequence_length * self.sample_every_n_frames):
                data_all.append(frames)

        return data_all

    def getTensor(self, index: int) -> torch.Tensor:
        '''
        Returns a tensor of the video frames at the given index.

        Args:
            index: The index of the video frames to return.

        Returns:
            A BCTHW tensor in the range `[0, 1]` of the video frames at the given index.

        '''
        video = self.data_all[index]
        video_len = len(video)

        # load the entire video when sequence_length = -1, whiel the sample_every_n_frames has to be 1
        if self.sequence_length == -1:
            assert self.sample_every_n_frames == 1
            start_idx = 0
            end_idx = video_len
        else:
            n_frames_interval = self.sequence_length * self.sample_every_n_frames
            start_idx = random.randint(0, video_len - n_frames_interval)
            end_idx = start_idx + n_frames_interval
        img = Image.open(video[0])
        h, w = img.height, img.width

        if h > w:
            half = (h - w) // 2
            cropsize = (0, half, w, half + w)  # left, upper, right, lower
        elif w > h:
            half = (w - h) // 2
            cropsize = (half, 0, half + h, h)

        images = []
        for i in range(start_idx, end_idx,
                       self.sample_every_n_frames):
            path = video[i]
            img = Image.open(path)

            if h != w:
                img = img.crop(cropsize)

            img = img.resize(
                (self.resolution, self.resolution),
                Image.ANTIALIAS)
            img = np.asarray(img, dtype=np.float32)
            img /= 255.
            img_tensor = preprocess_image(img).unsqueeze(0)
            images.append(img_tensor)

        video_clip = torch.cat(images).permute(3, 0, 1, 2)
        return video_clip

    def __len__(self):
        return self.video_num

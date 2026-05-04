# Adapted from https://github.com/universome/stylegan-v/blob/master/src/metrics/metric_utils.py
import os
import random
import torch
import pickle
import numpy as np

from typing import List, Tuple

def seed_everything(seed):
    random.seed(seed)
    os.environ['PYTHONHASHSEED'] = str(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed(seed)


class FeatureStats:
    '''
    Class to store statistics of features, including all features and mean/covariance.

    Args:
        capture_all: Whether to store all the features.
        capture_mean_cov: Whether to store mean and covariance.
        max_items: Maximum number of items to store.
    '''
    def __init__(self, capture_all: bool = False, capture_mean_cov: bool = False, max_items: int = None):
        '''
        '''
        self.capture_all = capture_all
        self.capture_mean_cov = capture_mean_cov
        self.max_items = max_items
        self.num_items = 0
        self.num_features = None
        self.all_features = None
        self.raw_mean = None
        self.raw_cov = None

    def set_num_features(self, num_features: int):
        '''
        Set the number of features diminsions.

        Args:
            num_features: Number of features diminsions.
        '''
        if self.num_features is not None:
            assert num_features == self.num_features
        else:
            self.num_features = num_features
            self.all_features = []
            self.raw_mean = np.zeros([num_features], dtype=np.float64)
            self.raw_cov = np.zeros([num_features, num_features], dtype=np.float64)

    def is_full(self) -> bool:
        '''
        Check if the maximum number of samples is reached.

        Returns:
            True if the storage is full, False otherwise.
        '''
        return (self.max_items is not None) and (self.num_items >= self.max_items)

    def append(self, x: np.ndarray):
        '''
        Add the newly computed features to the list. Update the mean and covariance.

        Args:
            x: New features to record.
        '''
        x = np.asarray(x, dtype=np.float32)
        assert x.ndim == 2
        if (self.max_items is not None) and (self.num_items + x.shape[0] > self.max_items):
            if self.num_items >= self.max_items:
                return
            x = x[:self.max_items - self.num_items]

        self.set_num_features(x.shape[1])
        self.num_items += x.shape[0]
        if self.capture_all:
            self.all_features.append(x)
        if self.capture_mean_cov:
            x64 = x.astype(np.float64)
            self.raw_mean += x64.sum(axis=0)
            self.raw_cov += x64.T @ x64

    def append_torch(self, x: torch.Tensor, rank: int, num_gpus: int):
        '''
        Add the newly computed PyTorch features to the list. Update the mean and covariance.

        Args:
            x: New features to record.
            rank: Rank of the current GPU.
            num_gpus: Total number of GPUs.
        '''
        assert isinstance(x, torch.Tensor) and x.ndim == 2
        assert 0 <= rank < num_gpus
        if num_gpus > 1:
            ys = []
            for src in range(num_gpus):
                y = x.clone()
                torch.distributed.broadcast(y, src=src)
                ys.append(y)
            x = torch.stack(ys, dim=1).flatten(0, 1) # interleave samples
        self.append(x.cpu().numpy())

    def get_all(self) -> np.ndarray:
        '''
        Get all the stored features as NumPy Array.

        Returns:
            Concatenation of the stored features.
        '''
        assert self.capture_all
        return np.concatenate(self.all_features, axis=0)

    def get_all_torch(self) -> torch.Tensor:
        '''
        Get all the stored features as PyTorch Tensor.

        Returns:
            Concatenation of the stored features.
        '''
        return torch.from_numpy(self.get_all())

    def get_mean_cov(self) -> Tuple[np.ndarray, np.ndarray]:
        '''
        Get the mean and covariance of the stored features.

        Returns:
            Mean and covariance of the stored features.
        '''
        assert self.capture_mean_cov
        mean = self.raw_mean / self.num_items
        cov = self.raw_cov / self.num_items
        cov = cov - np.outer(mean, mean)
        return mean, cov

    def save(self, pkl_file: str):
        '''
        Save the features and statistics to a pickle file.

        Args:
            pkl_file: Path to the pickle file.
        '''
        with open(pkl_file, 'wb') as f:
            pickle.dump(self.__dict__, f)

    @staticmethod
    def load(pkl_file: str) -> 'FeatureStats':
        '''
        Load the features and statistics from a pickle file.

        Args:
            pkl_file: Path to the pickle file.
        '''
        with open(pkl_file, 'rb') as f:
            s = pickle.load(f)
        obj = FeatureStats(capture_all=s['capture_all'], max_items=s['max_items'])
        obj.__dict__.update(s)
        print('Loaded %d features from %s' % (obj.num_items, pkl_file))
        return obj

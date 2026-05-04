# Adapted from https://github.com/Rudrabha/Wav2Lip/blob/master/audio.py

import librosa
import librosa.filters
import numpy as np
from scipy import signal
from scipy.io import wavfile
from omegaconf import OmegaConf
import torch

audio_config_path = "configs/audio.yaml"

config = OmegaConf.load(audio_config_path)


def load_wav(path, sr):
    return librosa.core.load(path, sr=sr)[0]


def save_wav(wav, path, sr):
    wav *= 32767 / max(0.01, np.max(np.abs(wav)))
    # proposed by @dsmiller
    wavfile.write(path, sr, wav.astype(np.int16))


def save_wavenet_wav(wav, path, sr):
    librosa.output.write_wav(path, wav, sr=sr)


def preemphasis(wav, k, preemphasize=True):
    if preemphasize:
        return signal.lfilter([1, -k], [1], wav)
    return wav


def inv_preemphasis(wav, k, inv_preemphasize=True):
    if inv_preemphasize:
        return signal.lfilter([1], [1, -k], wav)
    return wav


def get_hop_size():
    hop_size = config.audio.hop_size
    if hop_size is None:
        assert config.audio.frame_shift_ms is not None
        hop_size = int(config.audio.frame_shift_ms / 1000 * config.audio.sample_rate)
    return hop_size


def linearspectrogram(wav):
    D = _stft(preemphasis(wav, config.audio.preemphasis, config.audio.preemphasize))
    S = _amp_to_db(np.abs(D)) - config.audio.ref_level_db

    if config.audio.signal_normalization:
        return _normalize(S)
    return S


def melspectrogram(wav):
    D = _stft(preemphasis(wav, config.audio.preemphasis, config.audio.preemphasize))
    S = _amp_to_db(_linear_to_mel(np.abs(D))) - config.audio.ref_level_db

    if config.audio.signal_normalization:
        return _normalize(S)
    return S


def _lws_processor():
    import lws

    return lws.lws(config.audio.n_fft, get_hop_size(), fftsize=config.audio.win_size, mode="speech")


def _stft(y):
    if config.audio.use_lws:
        return _lws_processor(config.audio).stft(y).T
    else:
        return librosa.stft(y=y, n_fft=config.audio.n_fft, hop_length=get_hop_size(), win_length=config.audio.win_size)


##########################################################
# Those are only correct when using lws!!! (This was messing with Wavenet quality for a long time!)
def num_frames(length, fsize, fshift):
    """Compute number of time frames of spectrogram"""
    pad = fsize - fshift
    if length % fshift == 0:
        M = (length + pad * 2 - fsize) // fshift + 1
    else:
        M = (length + pad * 2 - fsize) // fshift + 2
    return M


def pad_lr(x, fsize, fshift):
    """Compute left and right padding"""
    M = num_frames(len(x), fsize, fshift)
    pad = fsize - fshift
    T = len(x) + 2 * pad
    r = (M - 1) * fshift + fsize - T
    return pad, pad + r


##########################################################
# Librosa correct padding
def librosa_pad_lr(x, fsize, fshift):
    return 0, (x.shape[0] // fshift + 1) * fshift - x.shape[0]


# Conversions
_mel_basis = None


def _linear_to_mel(spectogram):
    global _mel_basis
    if _mel_basis is None:
        _mel_basis = _build_mel_basis()
    return np.dot(_mel_basis, spectogram)


def _build_mel_basis():
    assert config.audio.fmax <= config.audio.sample_rate // 2
    return librosa.filters.mel(
        sr=config.audio.sample_rate,
        n_fft=config.audio.n_fft,
        n_mels=config.audio.num_mels,
        fmin=config.audio.fmin,
        fmax=config.audio.fmax,
    )


def _amp_to_db(x):
    min_level = np.exp(config.audio.min_level_db / 20 * np.log(10))
    return 20 * np.log10(np.maximum(min_level, x))


def _db_to_amp(x):
    return np.power(10.0, (x) * 0.05)


def _normalize(S):
    if config.audio.allow_clipping_in_normalization:
        if config.audio.symmetric_mels:
            return np.clip(
                (2 * config.audio.max_abs_value) * ((S - config.audio.min_level_db) / (-config.audio.min_level_db))
                - config.audio.max_abs_value,
                -config.audio.max_abs_value,
                config.audio.max_abs_value,
            )
        else:
            return np.clip(
                config.audio.max_abs_value * ((S - config.audio.min_level_db) / (-config.audio.min_level_db)),
                0,
                config.audio.max_abs_value,
            )

    assert S.max() <= 0 and S.min() - config.audio.min_level_db >= 0
    if config.audio.symmetric_mels:
        return (2 * config.audio.max_abs_value) * (
            (S - config.audio.min_level_db) / (-config.audio.min_level_db)
        ) - config.audio.max_abs_value
    else:
        return config.audio.max_abs_value * ((S - config.audio.min_level_db) / (-config.audio.min_level_db))


def _denormalize(D):
    if config.audio.allow_clipping_in_normalization:
        if config.audio.symmetric_mels:
            return (
                (np.clip(D, -config.audio.max_abs_value, config.audio.max_abs_value) + config.audio.max_abs_value)
                * -config.audio.min_level_db
                / (2 * config.audio.max_abs_value)
            ) + config.audio.min_level_db
        else:
            return (
                np.clip(D, 0, config.audio.max_abs_value) * -config.audio.min_level_db / config.audio.max_abs_value
            ) + config.audio.min_level_db

    if config.audio.symmetric_mels:
        return (
            (D + config.audio.max_abs_value) * -config.audio.min_level_db / (2 * config.audio.max_abs_value)
        ) + config.audio.min_level_db
    else:
        return (D * -config.audio.min_level_db / config.audio.max_abs_value) + config.audio.min_level_db


def get_melspec_overlap(audio_samples, melspec_length=52):
    mel_spec_overlap = melspectrogram(audio_samples.numpy())
    mel_spec_overlap = torch.from_numpy(mel_spec_overlap)
    i = 0
    mel_spec_overlap_list = []
    while i + melspec_length < mel_spec_overlap.shape[1] - 3:
        mel_spec_overlap_list.append(mel_spec_overlap[:, i : i + melspec_length].unsqueeze(0))
        i += 3
    mel_spec_overlap = torch.stack(mel_spec_overlap_list)
    return mel_spec_overlap

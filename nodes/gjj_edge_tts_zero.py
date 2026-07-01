from __future__ import annotations

import base64
import html
import os
import re
import socket
import ssl
import struct
import time
import uuid
import wave
from io import BytesIO
from typing import Any

import torch

try:
    from .common_utils.dependency_checker import build_node_help_payload
except Exception:
    def build_node_help_payload(**kwargs):
        return kwargs


NODE_NAME = "GJJ_EdgeTTS_ZeroDependency"
NODE_DISPLAY_NAME = "🔊 Edge TTS 零依赖"
EDGE_HOST = "speech.platform.bing.com"
EDGE_PATH = "/consumer/speech/synthesize/readaloud/edge/v1"
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm"
DEFAULT_SAMPLE_RATE = 24000
MAX_WS_PAYLOAD = 32 * 1024 * 1024

VOICE_IDS = {
    "[中文] zh-CN Xiaoxiao 女声": "zh-CN-XiaoxiaoNeural",
    "[中文] zh-CN Yunxi 男声": "zh-CN-YunxiNeural",
    "[中文] zh-CN Yunjian 男声": "zh-CN-YunjianNeural",
    "[中文] zh-CN Xiaoyi 女声": "zh-CN-XiaoyiNeural",
    "[中文] zh-CN Yunyang 男声": "zh-CN-YunyangNeural",
    "[中文] zh-CN Xiaobei 辽宁女声": "zh-CN-liaoning-XiaobeiNeural",
    "[中文] zh-CN Xiaoni 陕西女声": "zh-CN-shaanxi-XiaoniNeural",
    "[中文] zh-HK HiuMaan 女声": "zh-HK-HiuMaanNeural",
    "[中文] zh-HK WanLung 男声": "zh-HK-WanLungNeural",
    "[中文] zh-TW HsiaoChen 女声": "zh-TW-HsiaoChenNeural",
    "[中文] zh-TW YunJhe 男声": "zh-TW-YunJheNeural",
    "[English] en-US Jenny Female": "en-US-JennyNeural",
    "[English] en-US Guy Male": "en-US-GuyNeural",
    "[English] en-US Aria Female": "en-US-AriaNeural",
    "[English] en-GB Sonia Female": "en-GB-SoniaNeural",
    "[Japanese] ja-JP Nanami Female": "ja-JP-NanamiNeural",
    "[Japanese] ja-JP Keita Male": "ja-JP-KeitaNeural",
    "[Korean] ko-KR SunHi Female": "ko-KR-SunHiNeural",
    "[Korean] ko-KR InJoon Male": "ko-KR-InJoonNeural",
}


def _empty_audio(sample_rate: int = DEFAULT_SAMPLE_RATE, seconds: float = 0.05) -> dict[str, Any]:
    samples = max(1, int(float(sample_rate) * max(0.01, float(seconds))))
    return {"waveform": torch.zeros((1, 1, samples), dtype=torch.float32), "sample_rate": int(sample_rate)}


def _clean_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        raise RuntimeError("文本不能为空。")
    return text


def _rate_from_speed(speed: float) -> str:
    value = max(0.5, min(2.0, float(speed)))
    percent = int(round((value - 1.0) * 100.0))
    return "+0%" if percent == 0 else f"{percent:+d}%"


def _pitch_value(pitch: int) -> str:
    value = max(-20, min(20, int(pitch)))
    return f"{value:+d}Hz"


def _audio_from_wav_bytes(data: bytes) -> dict[str, Any]:
    if not data:
        raise RuntimeError("Edge TTS 没有返回音频。")
    with wave.open(BytesIO(data), "rb") as reader:
        channels = int(reader.getnchannels())
        sample_width = int(reader.getsampwidth())
        sample_rate = int(reader.getframerate())
        frames = int(reader.getnframes())
        raw = reader.readframes(frames)
    if sample_width != 2:
        raise RuntimeError(f"当前只支持 16-bit PCM，实际为 {sample_width * 8}-bit。")
    samples = torch.frombuffer(bytearray(raw), dtype=torch.int16).float() / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(dim=1)
    waveform = samples.reshape(1, 1, -1).contiguous()
    peak = float(waveform.abs().max()) if waveform.numel() else 0.0
    if peak > 1e-6:
        waveform = (waveform / max(1.0, peak)).clamp(-1.0, 1.0)
    return {"waveform": waveform, "sample_rate": sample_rate}


def _audio_from_raw_pcm(data: bytes, sample_rate: int = DEFAULT_SAMPLE_RATE) -> dict[str, Any]:
    if not data:
        raise RuntimeError("Edge TTS 没有返回音频。")
    samples = torch.frombuffer(bytearray(data), dtype=torch.int16).float() / 32768.0
    return {"waveform": samples.reshape(1, 1, -1).contiguous(), "sample_rate": int(sample_rate)}


class _StdlibWebSocket:
    def __init__(self, host: str, path: str, timeout: float = 30.0):
        self.host = host
        self.path = path
        self.timeout = float(timeout)
        self.sock: ssl.SSLSocket | None = None

    def __enter__(self):
        raw = socket.create_connection((self.host, 443), timeout=self.timeout)
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(raw, server_hostname=self.host)
        self.sock.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n"
            "User-Agent: Mozilla/5.0\r\n"
            "Pragma: no-cache\r\n"
            "Cache-Control: no-cache\r\n"
            "\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = self._recv_http_headers()
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError("Edge TTS WebSocket 连接失败。")
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        try:
            if self.sock is not None:
                self.sock.close()
        finally:
            self.sock = None

    def _recv_exact(self, size: int) -> bytes:
        if self.sock is None:
            raise RuntimeError("WebSocket 尚未连接。")
        chunks = bytearray()
        while len(chunks) < size:
            chunk = self.sock.recv(size - len(chunks))
            if not chunk:
                raise RuntimeError("Edge TTS 连接提前关闭。")
            chunks.extend(chunk)
        return bytes(chunks)

    def _recv_http_headers(self) -> bytes:
        if self.sock is None:
            raise RuntimeError("WebSocket 尚未连接。")
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 65536:
                raise RuntimeError("Edge TTS 握手响应过大。")
        return bytes(data)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.sock is None:
            raise RuntimeError("WebSocket 尚未连接。")
        length = len(payload)
        header = bytearray([0x80 | int(opcode)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.extend((0x80 | 126, *struct.pack("!H", length)))
        else:
            header.extend((0x80 | 127, *struct.pack("!Q", length)))
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def recv_message(self) -> tuple[int, bytes]:
        chunks = bytearray()
        message_opcode = 0
        while True:
            first, second = self._recv_exact(2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            if length > MAX_WS_PAYLOAD:
                raise RuntimeError("Edge TTS 返回数据过大。")
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                return opcode, payload
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode in (0x1, 0x2):
                message_opcode = opcode
                chunks = bytearray(payload)
            elif opcode == 0x0:
                chunks.extend(payload)
            if fin and message_opcode:
                return message_opcode, bytes(chunks)


def _edge_headers(path: str, request_id: str, content_type: str = "application/json") -> str:
    return (
        f"X-RequestId:{request_id}\r\n"
        f"Content-Type:{content_type}\r\n"
        f"Path:{path}\r\n\r\n"
    )


def _ssml(text: str, voice: str, rate: str, pitch: str) -> str:
    escaped = html.escape(text, quote=False)
    voice_attr = html.escape(voice, quote=True)
    return (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' "
        "xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='zh-CN'>"
        f"<voice name='{voice_attr}'><prosody rate='{rate}' pitch='{pitch}'>{escaped}</prosody></voice>"
        "</speak>"
    )


def _synthesize_edge_tts(text: str, voice: str, speed: float, pitch: int, timeout: float) -> dict[str, Any]:
    request_id = uuid.uuid4().hex
    connection_id = uuid.uuid4().hex
    timestamp = time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime())
    path = f"{EDGE_PATH}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&ConnectionId={connection_id}"
    config = (
        _edge_headers("speech.config", request_id)
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + f'"outputFormat":"{OUTPUT_FORMAT}"'
        + "}}}}\r\n"
    )
    ssml_payload = (
        f"X-RequestId:{request_id}\r\n"
        "Content-Type:application/ssml+xml\r\n"
        f"X-Timestamp:{timestamp}\r\n"
        "Path:ssml\r\n\r\n"
        + _ssml(text, voice, _rate_from_speed(speed), _pitch_value(pitch))
    )
    audio = bytearray()
    with _StdlibWebSocket(EDGE_HOST, path, timeout=timeout) as ws:
        ws.send_text(config)
        ws.send_text(ssml_payload)
        while True:
            opcode, payload = ws.recv_message()
            if opcode == 0x8:
                break
            header_end = payload.find(b"\r\n\r\n")
            headers = payload[:header_end].decode("utf-8", "ignore") if header_end >= 0 else payload.decode("utf-8", "ignore")
            body = payload[header_end + 4 :] if header_end >= 0 else b""
            if "Path:audio" in headers:
                audio.extend(body)
            elif "Path:turn.end" in headers:
                break
    data = bytes(audio)
    if data.startswith(b"RIFF"):
        return _audio_from_wav_bytes(data)
    return _audio_from_raw_pcm(data, DEFAULT_SAMPLE_RATE)


class GJJ_EdgeTTS_ZeroDependency:
    DESCRIPTION = "Edge TTS 零依赖复刻版：不依赖 edge_tts、torchaudio 或外部 config，直接输出 ComfyUI AUDIO。"
    CATEGORY = "GJJ/Audio"
    FUNCTION = "tts"
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("音频",)
    GJJ_HELP = build_node_help_payload(
        description=DESCRIPTION,
        dependencies=[
            {"name": "torch", "type": "ComfyUI 内置", "required": True, "description": "用于输出 AUDIO 张量。"},
            {"name": "Python 标准库", "type": "内置", "required": True, "description": "通过 ssl/socket/wave 连接 Edge TTS 并解析 PCM。"},
        ],
        notice="需要运行环境能访问 Microsoft Edge 在线语音服务；无需安装 edge-tts、torchaudio。",
    )

    @classmethod
    def INPUT_TYPES(cls):
        voices = list(VOICE_IDS.keys())
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "placeholder": "输入要朗读的文本"}),
                "voice": (voices, {"default": voices[0], "tooltip": "选择 Edge TTS 语音"}),
            },
            "optional": {
                "custom_voice": ("STRING", {"default": "", "multiline": False, "tooltip": "可选：直接填写 Edge voice id，例如 zh-CN-XiaoxiaoNeural"}),
                "speed": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.1, "tooltip": "语速倍率"}),
                "pitch": ("INT", {"default": 0, "min": -20, "max": 20, "step": 1, "tooltip": "音调，单位 Hz"}),
                "timeout": ("FLOAT", {"default": 30.0, "min": 5.0, "max": 180.0, "step": 1.0, "tooltip": "网络超时秒数"}),
                "fail_mode": (["静音占位", "报错"], {"default": "静音占位", "tooltip": "TTS 失败时返回短静音或直接报错"}),
            },
        }

    def tts(
        self,
        text: str,
        voice: str,
        custom_voice: str = "",
        speed: float = 1.0,
        pitch: int = 0,
        timeout: float = 30.0,
        fail_mode: str = "静音占位",
    ):
        clean = _clean_text(text)
        voice_id = str(custom_voice or "").strip() or VOICE_IDS.get(str(voice), str(voice))
        try:
            audio = _synthesize_edge_tts(clean, voice_id, float(speed), int(pitch), float(timeout))
            return (audio,)
        except Exception as exc:
            if str(fail_mode) == "报错":
                raise RuntimeError(f"Edge TTS 生成失败：{exc}") from exc
            print(f"[GJJ EdgeTTS Zero] 生成失败，返回静音占位：{exc}")
            return (_empty_audio(),)


NODE_CLASS_MAPPINGS = {
    NODE_NAME: GJJ_EdgeTTS_ZeroDependency,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: NODE_DISPLAY_NAME,
}

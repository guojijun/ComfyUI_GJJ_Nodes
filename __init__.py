print("\033[1;92m" + r"""
💛 ██████╗ ██╗   ██╗███████╗       ██╗ ██╗       ██╗██╗   ██╗███╗   ██╗💛
💛██╔════╝ ██║   ██║██╔══██║       ██║ ██║       ██║██║   ██║████╗  ██║💛
💛██║  ███╗██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██╔██╗ ██║💛
💛██║   ██║██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██║╚██╗██║💛
💛╚██████╔╝╚██████╔╝███████║ ╚██████╔╝╚██║ ╚██████╔╝╚██████╔╝██║ ╚████║💛
💛 ╚═════╝  ╚═════╝ ╚══════╝  ╚═════╝  ╚═╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝💛
""".strip() + "\033[0m")
import traceback
from .nodes import *
WEB_DIRECTORY = "./js"
def _serialize_help_value(value):
	if value is None or isinstance(value, (str, int, float, bool)):
		return value
	if isinstance(value, (list, tuple, set)):
		return [_serialize_help_value(item) for item in value]
	if isinstance(value, dict):
		return {str(key): _serialize_help_value(item) for key, item in value.items()}
	return str(value)
def _build_node_help_payload():
	payload = {}
	for node_name, node_cls in NODE_CLASS_MAPPINGS.items():
		help_data = getattr(node_cls, "GJJ_HELP", None)
		ui_data = getattr(node_cls, "GJJ_UI", None)
		required_models = getattr(node_cls, "REQUIRED_MODELS", None)
		if help_data is None and required_models:
			help_data = {"models": required_models}
		payload[str(node_name)] = {
			"description": str(getattr(node_cls, "DESCRIPTION", "") or ""),
			"help": _serialize_help_value(help_data or {}),
			"ui": _serialize_help_value(ui_data or {}),
		}
	return payload

class _GJJTemporaryPromptId:
	def __init__(self, server, prompt_id):
		self.server = server
		self.prompt_id = str(prompt_id or "")
		self.had_value = False
		self.previous_value = None
		self.applied = False

	def __enter__(self):
		if self.server is None or not self.prompt_id:
			return self
		try:
			self.previous_value = getattr(self.server, "last_prompt_id")
			self.had_value = True
		except AttributeError:
			self.had_value = False
		except Exception:
			self.had_value = False
		try:
			setattr(self.server, "last_prompt_id", self.prompt_id)
			self.applied = True
		except Exception:
			self.applied = False
		return self

	def __exit__(self, _exc_type, _exc, _traceback):
		if self.server is None or not self.applied:
			return False
		try:
			if self.had_value:
				setattr(self.server, "last_prompt_id", self.previous_value)
			elif hasattr(self.server, "last_prompt_id"):
				delattr(self.server, "last_prompt_id")
		except Exception:
			pass
		return False

def _register_gjj_help_api():
	try:
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 节点帮助接口注册失败：{exc}")
		return
	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_node_help_api_registered", False):
		return
	@server.routes.get("/gjj/node_help")
	async def gjj_node_help(_request):
		return web.json_response(_build_node_help_payload())
	server._gjj_node_help_api_registered = True
_register_gjj_help_api()

def _gjj_package_root():
	from pathlib import Path
	return Path(__file__).resolve().parent

def _gjj_package_workflows_directory() -> str:
	import os
	return os.path.abspath(str(_gjj_package_root() / "workflows"))

def _gjj_user_settings_path():
	return _gjj_package_root() / "presets" / "gjj_user_settings.json"

def _gjj_default_user_settings() -> dict:
	try:
		from .nodes.gjj_ollama_common import ollama_assistant_default_settings
		ollama_assistant = ollama_assistant_default_settings()
	except Exception:
		ollama_assistant = {}
	return {
		"version": 1,
		"workflow_screenshot": {
			"directory": "workflows",
			"filename_template": "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png",
			"sort_mode": "mtime_desc",
			"filter_mode": "openable",
			"search_text": "",
			"page_size": 8,
		},
		"workflow_title": {
			"font": "",
			"fontSize": 72,
			"colorA": "#F8FFF7",
			"colorB": "#55C685",
			"gradient": True,
			"gradientDirection": "水平",
			"opacity": 1.0,
			"letterSpacing": 1.0,
			"lineSpacing": 12.0,
			"paddingX": 0.0,
			"paddingY": 0.0,
			"strokeWidth": 2.0,
			"strokeMode": "自定义",
			"strokeColor": "#2E7D62",
			"strokeOpacity": 1.0,
			"backgroundColor": "#1E5A48",
			"borderMode": "透明",
			"borderColor": "#55C685",
			"borderOpacity": 1.0,
			"shadowEnabled": True,
			"shadowColor": "#F2FF04",
			"shadowOpacity": 0.42,
			"shadowBlur": 8.0,
			"shadowX": 2.0,
			"shadowY": 4.0,
			"align": "居中",
		},
		"character_library": {
			"matting_method": "RMBG1.4",
			"multiview_unet": "qwen_image_edit_2511_int4_convrot.safetensors",
			"multiview_clip": "qwen_2.5_vl_7b_int4_convrot.safetensors",
			"multiview_vae": "qwen_image_vae.safetensors",
			"multiview_lora_1": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
			"multiview_lora_2": "qwen-image-edit-2511-multiple-angles-lora.safetensors",
			"annotate_clip": "qwen3.5_4b_fp8_mixed.safetensors",
			"sampling_sampler": "自动",
			"sampling_scheduler": "自动",
			"sampling_steps": 0,
			"sampling_cfg": -1.0,
			"sampling_denoise": -1.0,
			"sampling_seed": 0,
			"keep_model": True,
		},
		"scene_library": {
			"panorama_unet": "qwen_image_edit_2511_int4_convrot.safetensors",
			"panorama_clip": "qwen_2.5_vl_7b_int4_convrot.safetensors",
			"panorama_vae": "qwen_image_vae.safetensors",
			"annotate_clip": "qwen3.5_4b_fp8_mixed.safetensors",
			"seedvr2_dit": "seedvr2_3b_int8_convrot.safetensors",
			"seedvr2_vae": "ema_vae_fp16.safetensors",
		},
		"ollama_assistant": ollama_assistant,
		"nodes": {},
		"user": {},
		"execution_timer": {
			"enabled": True,
			"position": None,
			"newest_first": False,
			"collapsed": False,
		},
		"queue_finish_command": {
			"enabled": False,
			"action": "none",
			"custom_command": "",
			"delay_seconds": 10,
			"only_on_success": True,
			"audio_file": "",
			"smtp_host": "",
			"smtp_port": 465,
			"smtp_security": "ssl",
			"smtp_username": "",
			"smtp_password": "",
			"mail_from": "",
			"mail_to": "",
			"mail_subject": "ComfyUI 队列已完成",
			"mail_body": "ComfyUI 队列已全部执行完成。",
		},
	}

def _gjj_merge_dict(defaults: dict, value) -> dict:
	if not isinstance(value, dict):
		value = {}
	result = {}
	for key, default_value in defaults.items():
		if isinstance(default_value, dict):
			result[key] = _gjj_merge_dict(default_value, value.get(key))
		else:
			result[key] = value.get(key, default_value)
	for key, item in value.items():
		if key not in result:
			result[key] = item
	return result

def _gjj_read_user_settings() -> dict:
	import json
	path = _gjj_user_settings_path()
	data = {}
	if path.is_file():
		try:
			data = json.loads(path.read_text(encoding="utf-8"))
		except Exception:
			data = {}
	return _gjj_merge_dict(_gjj_default_user_settings(), data)

def _gjj_write_user_settings(data: dict) -> dict:
	import json
	import os
	settings = _gjj_merge_dict(_gjj_default_user_settings(), data)
	path = _gjj_user_settings_path()
	path.parent.mkdir(parents=True, exist_ok=True)
	tmp = path.with_suffix(path.suffix + ".tmp")
	tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
	os.replace(str(tmp), str(path))
	return settings

def _gjj_expand_setting_path(value: str, fallback: str) -> str:
	import os
	raw = str(value or "").strip()
	if not raw:
		return os.path.abspath(fallback)
	expanded = os.path.expanduser(os.path.expandvars(raw))
	if not os.path.isabs(expanded):
		expanded = str(_gjj_package_root() / expanded)
	return os.path.abspath(expanded)

def _gjj_workflow_screenshot_settings() -> dict:
	settings = _gjj_read_user_settings()
	section = settings.get("workflow_screenshot") if isinstance(settings, dict) else {}
	if not isinstance(section, dict):
		section = {}
	try:
		page_size = int(section.get("page_size") or 8)
	except Exception:
		page_size = 8
	page_size = max(1, min(100, page_size))
	return {
		"directory": str(section.get("directory") or ""),
		"filename_template": str(section.get("filename_template") or "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png"),
		"sort_mode": str(section.get("sort_mode") or "mtime_desc"),
		"filter_mode": str(section.get("filter_mode") or "openable"),
		"search_text": str(section.get("search_text") or ""),
		"page_size": page_size,
	}

def _gjj_section_settings(section: str) -> dict:
	settings = _gjj_read_user_settings()
	value = settings.get(section) if isinstance(settings, dict) else {}
	return value if isinstance(value, dict) else {}

def _gjj_model_filename_choices(category: str) -> list[str]:
	try:
		import folder_paths
		items = folder_paths.get_filename_list(category) or []
	except Exception:
		items = []
	result = []
	seen = set()
	for item in items:
		text = str(item or "").replace("\\", "/").strip()
		key = text.lower()
		if not text or key in seen:
			continue
		seen.add(key)
		result.append(text)
	return result

def _gjj_library_model_choices() -> dict:
	try:
		from .nodes.gjj_comprehensive_matting import METHODS as matting_methods
	except Exception:
		matting_methods = ["RMBG1.4"]
	return {
		"text_encoders": _gjj_model_filename_choices("text_encoders"),
		"diffusion_models": _gjj_model_filename_choices("diffusion_models"),
		"vae": _gjj_model_filename_choices("vae"),
		"loras": _gjj_model_filename_choices("loras"),
		"matting_methods": list(matting_methods) or ["RMBG1.4"],
	}

def _register_gjj_user_settings_api():
	try:
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 用户参数存储接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_user_settings_api_registered", False):
		return

	@server.routes.get("/gjj/user_settings")
	async def gjj_user_settings_get(_request):
		settings = _gjj_write_user_settings(_gjj_read_user_settings())
		return web.json_response({
			"ok": True,
			"path": str(_gjj_user_settings_path()),
			"settings": settings,
		})

	@server.routes.post("/gjj/user_settings")
	async def gjj_user_settings_post(request):
		try:
			data = await request.json()
			settings = _gjj_read_user_settings()
			if isinstance(data.get("settings"), dict):
				settings = _gjj_merge_dict(settings, data.get("settings"))
			else:
				section = str(data.get("section") or "").strip()
				values = data.get("values")
				if not section or not isinstance(values, dict):
					raise ValueError("缺少 section 或 values。")
				current = settings.get(section)
				if not isinstance(current, dict):
					current = {}
				current.update(values)
				settings[section] = current
			settings = _gjj_write_user_settings(settings)
			return web.json_response({
				"ok": True,
				"path": str(_gjj_user_settings_path()),
				"settings": settings,
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	server._gjj_user_settings_api_registered = True
_register_gjj_user_settings_api()

def _register_gjj_queue_finish_command_api():
	try:
		from email.message import EmailMessage
		import os
		import platform
		import signal
		import smtplib
		import subprocess
		import threading
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 队列完成命令接口注册失败：{exc}")
		return
	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_queue_finish_command_api_registered", False):
		return

	def command_for_action(action: str, custom_command: str) -> str:
		system = platform.system().lower()
		if action == "custom":
			return str(custom_command or "").strip()
		if system == "windows":
			return {
				"shutdown": "shutdown.exe /s /t 0",
				"sleep": "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
				"hibernate": "shutdown.exe /h",
			}.get(action, "")
		if system == "darwin":
			return {
				"shutdown": "osascript -e 'tell application \"System Events\" to shut down'",
				"sleep": "pmset sleepnow",
				"hibernate": "pmset sleepnow",
			}.get(action, "")
		return {
			"shutdown": "systemctl poweroff",
			"sleep": "systemctl suspend",
			"hibernate": "systemctl hibernate",
		}.get(action, "")

	def launch_command(command: str):
		try:
			creationflags = 0
			startupinfo = None
			if os.name == "nt":
				creationflags = (
					getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
					| getattr(subprocess, "DETACHED_PROCESS", 0)
				)
				startupinfo = subprocess.STARTUPINFO()
				startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
			subprocess.Popen(
				command,
				shell=True,
				stdin=subprocess.DEVNULL,
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
				cwd=str(_gjj_package_root()),
				creationflags=creationflags,
				startupinfo=startupinfo,
			)
			print(f"[GJJ] 队列已完成，系统命令已启动：{command}")
		except Exception as exc:
			print(f"[GJJ] 队列完成命令执行失败：{exc}")

	def play_audio(config: dict):
		raw_path = str(config.get("audio_file") or "").strip()
		if not raw_path:
			raise ValueError("未设置音频文件。")
		path = _gjj_expand_setting_path(raw_path, str(_gjj_package_root()))
		if not os.path.isfile(path):
			raise FileNotFoundError(f"音频文件不存在：{path}")
		system = platform.system().lower()
		if system == "windows":
			os.startfile(path)
		elif system == "darwin":
			subprocess.Popen(["afplay", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
		else:
			subprocess.Popen(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

	def send_email(config: dict):
		host = str(config.get("smtp_host") or "").strip()
		username = str(config.get("smtp_username") or "").strip()
		password = str(config.get("smtp_password") or "")
		sender = str(config.get("mail_from") or username).strip()
		recipients = [
			item.strip()
			for item in str(config.get("mail_to") or "").replace(";", ",").split(",")
			if item.strip()
		]
		if not host or not sender or not recipients:
			raise ValueError("发送邮件需要填写 SMTP 服务器、发件人和收件人。")
		try:
			port = int(config.get("smtp_port") or 465)
		except Exception:
			port = 465
		security = str(config.get("smtp_security") or "ssl").strip().lower()
		message = EmailMessage()
		message["From"] = sender
		message["To"] = ", ".join(recipients)
		message["Subject"] = str(config.get("mail_subject") or "ComfyUI 队列已完成")
		message.set_content(str(config.get("mail_body") or "ComfyUI 队列已全部执行完成。"))
		client_cls = smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP
		with client_cls(host, port, timeout=30) as client:
			if security == "starttls":
				client.starttls()
			if username:
				client.login(username, password)
			client.send_message(message)

	def run_finish_action(action: str, config: dict):
		try:
			if action == "audio":
				play_audio(config)
				print("[GJJ] 队列已完成，已启动播放提示音。")
			elif action == "email":
				send_email(config)
				print("[GJJ] 队列已完成，通知邮件已发送。")
			elif action == "close_comfyui":
				print("[GJJ] 队列已完成，正在关闭 ComfyUI...")
				os.kill(os.getpid(), signal.SIGINT)
			else:
				command = command_for_action(action, config.get("custom_command"))
				if not command:
					raise ValueError("没有可执行的队列完成操作。")
				launch_command(command)
		except Exception as exc:
			print(f"[GJJ] 队列完成操作失败：{exc}")

	@server.routes.post("/gjj/queue_finish_command/run")
	async def gjj_queue_finish_command_run(_request):
		config = _gjj_section_settings("queue_finish_command")
		if config.get("enabled") is not True:
			return web.json_response({"ok": False, "error": "队列完成命令未启用。"}, status=403)
		action = str(config.get("action") or "none").strip().lower()
		if action == "none":
			return web.json_response({"ok": True, "action": action, "skipped": True})
		if action not in {"shutdown", "sleep", "hibernate", "custom", "audio", "email", "close_comfyui"}:
			return web.json_response({"ok": False, "error": "不支持的队列完成操作。"}, status=400)
		threading.Timer(0.35, run_finish_action, args=(action, config)).start()
		return web.json_response({"ok": True, "action": action})

	server._gjj_queue_finish_command_api_registered = True

_register_gjj_queue_finish_command_api()

def _register_gjj_workflow_screenshot_api():
	try:
		import base64
		import os
		import re
		import subprocess
		import sys
		from pathlib import Path
		from urllib.parse import urlencode
		import folder_paths
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 工作流截图接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_workflow_screenshot_api_registered", False):
		return

	SAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1F]+')
	LEGACY_DEFAULT_SUBDIR = os.path.join("GJJ", "workflow_screenshots")

	def default_directory() -> str:
		config = _gjj_workflow_screenshot_settings()
		return _gjj_expand_setting_path(config.get("directory") or "", _gjj_package_workflows_directory())

	def filename_template() -> str:
		value = _gjj_workflow_screenshot_settings().get("filename_template") or ""
		if not value or value in {"GJJ_workflow_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png", "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.jpg"}:
			return "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png"
		return value

	def legacy_default_directory() -> str:
		return os.path.abspath(os.path.join(folder_paths.get_output_directory(), LEGACY_DEFAULT_SUBDIR))

	def clean_filename(value: str) -> str:
		name = os.path.basename(str(value or "").strip()) or "GJJ_workflow.png"
		name = SAFE_FILENAME_RE.sub("_", name).strip(" .")
		if not name:
			name = "GJJ_workflow.png"
		if not re.search(r"\.(png|jpe?g)$", name, re.IGNORECASE):
			name += ".png"
		return name[:180]

	def resolve_directory(value: str | None) -> str:
		raw = str(value or "").strip()
		path = _gjj_expand_setting_path(raw, default_directory())
		os.makedirs(path, exist_ok=True)
		return path

	def image_path(directory: str, filename: str) -> str:
		base = resolve_directory(directory)
		name = clean_filename(filename)
		path = os.path.abspath(os.path.join(base, name))
		if os.path.dirname(path) != base:
			raise ValueError("文件名不安全。")
		return path

	def newest_image_path(directory: str) -> str:
		base = resolve_directory(directory)
		newest = ""
		newest_mtime = -1.0
		for entry in [p for pattern in ("*.jpg", "*.jpeg", "*.png") for p in Path(base).glob(pattern)]:
			try:
				mtime = entry.stat().st_mtime
			except OSError:
				continue
			if mtime > newest_mtime:
				newest = str(entry)
				newest_mtime = mtime
		return os.path.abspath(newest) if newest else ""

	def item_url(directory: str, filename: str, mtime: float) -> str:
		query = urlencode({
			"directory": directory,
			"filename": filename,
			"mtime": int(mtime),
		})
		return f"/gjj/workflow_screenshot/file?{query}"

	def decode_image_data(value: str, filename: str) -> bytes:
		text = str(value or "")
		if "," in text and text.lower().startswith("data:"):
			text = text.split(",", 1)[1]
		data = base64.b64decode(text, validate=False)
		lowered = clean_filename(filename).lower()
		if lowered.endswith(".png") and not data.startswith(b"\x89PNG\r\n\x1a\n"):
			raise ValueError("PNG 文件数据无效。")
		if lowered.endswith((".jpg", ".jpeg")) and not data.startswith(b"\xff\xd8"):
			raise ValueError("JPG 文件数据无效。")
		return data

	def activate_windows_explorer_window(directory: str) -> bool:
		if not sys.platform.startswith("win"):
			return False
		try:
			import ctypes
			import time

			user32 = ctypes.windll.user32
			target_name = os.path.basename(os.path.normpath(directory)).lower()
			target_path = os.path.normcase(os.path.abspath(directory)).lower()
			enum_proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
			classes = {"CabinetWClass", "ExploreWClass"}

			def find_window():
				matches = []

				@enum_proc_type
				def callback(hwnd, _lparam):
					if not user32.IsWindowVisible(hwnd):
						return True
					class_buffer = ctypes.create_unicode_buffer(256)
					user32.GetClassNameW(hwnd, class_buffer, len(class_buffer))
					if class_buffer.value not in classes:
						return True
					length = max(1, user32.GetWindowTextLengthW(hwnd))
					title_buffer = ctypes.create_unicode_buffer(length + 1)
					user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
					title = str(title_buffer.value or "").strip().lower()
					if title and (target_path in os.path.normcase(title).lower() or title == target_name or target_name in title):
						matches.append(hwnd)
					return True

				user32.EnumWindows(callback, 0)
				return matches[0] if matches else None

			for _ in range(10):
				hwnd = find_window()
				if hwnd:
					user32.ShowWindowAsync(hwnd, 3)
					user32.BringWindowToTop(hwnd)
					user32.SetForegroundWindow(hwnd)
					return True
				time.sleep(0.12)
		except Exception:
			return False
		return False

	def open_windows_explorer(directory: str, select_path: str = "") -> bool:
		flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
		if select_path and os.path.exists(select_path):
			subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", f"/select,{select_path}"], creationflags=flags)
			return activate_windows_explorer_window(os.path.dirname(select_path))
		subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", "/n,", directory], creationflags=flags)
		return activate_windows_explorer_window(directory)

	@server.routes.get("/gjj/workflow_screenshot/info")
	async def gjj_workflow_screenshot_info(_request):
		directory = default_directory()
		os.makedirs(directory, exist_ok=True)
		return web.json_response({
			"default_directory": directory,
			"package_default_directory": _gjj_package_workflows_directory(),
			"legacy_default_directory": legacy_default_directory(),
			"directory": directory,
			"settings_path": str(_gjj_user_settings_path()),
			"workflow_screenshot": {
				"directory": directory,
				"raw_directory": _gjj_workflow_screenshot_settings().get("directory") or "",
				"filename_template": filename_template(),
				"sort_mode": _gjj_workflow_screenshot_settings().get("sort_mode") or "mtime_desc",
				"filter_mode": _gjj_workflow_screenshot_settings().get("filter_mode") or "openable",
				"search_text": _gjj_workflow_screenshot_settings().get("search_text") or "",
				"page_size": _gjj_workflow_screenshot_settings().get("page_size") or 8,
			},
		})

	@server.routes.post("/gjj/workflow_screenshot/save")
	async def gjj_workflow_screenshot_save(request):
		try:
			data = await request.json()
			directory = resolve_directory(data.get("directory"))
			filename = clean_filename(data.get("filename"))
			path = image_path(directory, filename)
			raw = decode_image_data(data.get("image") or data.get("png") or "", filename)
			with open(path, "wb") as handle:
				handle.write(raw)
			stat = os.stat(path)
			server._gjj_workflow_screenshot_last_path = path
			return web.json_response({
				"ok": True,
				"filename": filename,
				"path": path,
				"directory": directory,
				"size": stat.st_size,
				"mtime": stat.st_mtime,
				"url": item_url(directory, filename, stat.st_mtime),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/workflow_screenshot/list")
	async def gjj_workflow_screenshot_list(request):
		try:
			directory = resolve_directory(request.query.get("directory"))
			items = []
			entries = [p for pattern in ("*.jpg", "*.jpeg", "*.png") for p in Path(directory).glob(pattern)]
			for entry in sorted(entries, key=lambda item: item.stat().st_mtime, reverse=True):
				try:
					stat = entry.stat()
				except OSError:
					continue
				items.append({
					"filename": entry.name,
					"path": str(entry),
					"directory": directory,
					"size": stat.st_size,
					"mtime": stat.st_mtime,
					"url": item_url(directory, entry.name, stat.st_mtime),
				})
			return web.json_response({
				"ok": True,
				"directory": directory,
				"default_directory": default_directory(),
				"package_default_directory": _gjj_package_workflows_directory(),
				"legacy_default_directory": legacy_default_directory(),
				"settings_path": str(_gjj_user_settings_path()),
				"workflow_screenshot": {
					"directory": default_directory(),
					"raw_directory": _gjj_workflow_screenshot_settings().get("directory") or "",
					"filename_template": filename_template(),
					"sort_mode": _gjj_workflow_screenshot_settings().get("sort_mode") or "mtime_desc",
					"filter_mode": _gjj_workflow_screenshot_settings().get("filter_mode") or "openable",
					"search_text": _gjj_workflow_screenshot_settings().get("search_text") or "",
					"page_size": _gjj_workflow_screenshot_settings().get("page_size") or 8,
				},
				"items": items,
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc), "items": []}, status=400)

	@server.routes.get("/gjj/workflow_screenshot/file")
	async def gjj_workflow_screenshot_file(request):
		try:
			path = image_path(request.query.get("directory"), request.query.get("filename"))
			if not os.path.exists(path):
				return web.Response(status=404, text="not found")
			return web.FileResponse(path, headers={"Cache-Control": "no-store"})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.post("/gjj/workflow_screenshot/open_dir")
	async def gjj_workflow_screenshot_open_dir(request):
		try:
			data = await request.json()
			directory = resolve_directory(data.get("directory"))
			select_path = ""
			select_file = bool(data.get("select_file") or data.get("selectFile") or data.get("select"))
			filename = str(data.get("filename") or "").strip()
			if select_file and filename:
				try:
					candidate = image_path(directory, filename)
					if os.path.exists(candidate):
						select_path = candidate
				except Exception:
					select_path = ""
			if select_file and not select_path:
				last_path = os.path.abspath(str(getattr(server, "_gjj_workflow_screenshot_last_path", "") or ""))
				if os.path.exists(last_path) and os.path.dirname(last_path) == directory:
					select_path = last_path
			if select_file and not select_path:
				select_path = newest_image_path(directory)

			foreground = False
			if sys.platform.startswith("win"):
				if select_path and os.path.exists(select_path):
					foreground = open_windows_explorer(directory, select_path)
				else:
					foreground = open_windows_explorer(directory)
			elif sys.platform == "darwin":
				subprocess.Popen(["open", directory])
			else:
				subprocess.Popen(["xdg-open", directory])
			return web.json_response({"ok": True, "directory": directory, "selected": select_path, "foreground": foreground})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	server._gjj_workflow_screenshot_api_registered = True
_register_gjj_workflow_screenshot_api()

def _gjj_character_library_directory():
	from pathlib import Path
	try:
		import folder_paths
		models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
	except Exception:
		models_dir = Path()
	if not str(models_dir):
		models_dir = _gjj_package_root().parent.parent / "models"
	return models_dir / "GJJ" / "character_library"

def _gjj_legacy_character_library_directory():
	return _gjj_package_root() / "presets" / "character_library"

def _register_gjj_character_library_api():
	try:
		import base64
		import io
		import json
		import os
		import re
		import shutil
		import subprocess
		import sys
		import time
		import uuid
		from pathlib import Path
		from urllib.parse import urlencode
		from PIL import Image, ImageFilter, ImageOps
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 角色库接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_character_library_api_registered", False):
		return

	SAFE_TEXT_RE = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")
	GENDER_PREFIX_RE = re.compile(r"^\s*(?:♀️|♂️|♀|♂)\s*")
	PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

	def now_ms() -> int:
		return int(time.time() * 1000)

	def root_dir() -> Path:
		path = _gjj_character_library_directory()
		path.mkdir(parents=True, exist_ok=True)
		legacy = _gjj_legacy_character_library_directory()
		if legacy.exists() and legacy.is_dir():
			try:
				has_new_items = any(path.iterdir())
			except Exception:
				has_new_items = False
			if not has_new_items:
				for entry in legacy.iterdir():
					target = path / entry.name
					if target.exists():
						continue
					if entry.is_dir():
						shutil.move(str(entry), str(target))
					elif entry.is_file():
						shutil.move(str(entry), str(target))
		return path

	def voice_root_dir() -> Path:
		try:
			import folder_paths
			models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
		except Exception:
			models_dir = Path()
		if not str(models_dir):
			models_dir = _gjj_package_root().parent.parent / "models"
		path = (models_dir / "GJJ" / "wav").resolve()
		path.mkdir(parents=True, exist_ok=True)
		return path

	def clean_key(value: str, fallback: str = "item") -> str:
		text = SAFE_TEXT_RE.sub("_", str(value or "").strip()).strip("._- ")
		return (text or fallback)[:80]

	def strip_gender_prefix(value: str) -> str:
		return GENDER_PREFIX_RE.sub("", str(value or "")).strip()

	def character_reference_name(data: dict, fallback: str = "") -> str:
		return strip_gender_prefix(data.get("name") or fallback or data.get("id") or "") or str(fallback or data.get("id") or "")

	def clean_voice_path(value: str) -> str:
		raw = str(value or "").strip().replace("\\", "/").lstrip("/")
		if not raw:
			return ""
		parts = [clean_key(part, "") for part in raw.split("/") if clean_key(part, "")]
		if not parts or Path(parts[-1]).suffix.lower() not in {".wav", ".mp3"}:
			return ""
		return "/".join(parts)[:220]

	def voice_path_from_relative(relative_path: str) -> Path:
		clean = clean_voice_path(relative_path)
		if not clean:
			raise ValueError("音色路径无效，只支持 models/GJJ/wav 下的 wav / mp3 文件。")
		base = voice_root_dir()
		path = (base / clean).resolve()
		if base not in path.parents and path != base:
			raise ValueError("音色路径不安全。")
		return path

	def default_voice_path_for_character(data: dict) -> str:
		candidates = []
		for value in (character_reference_name(data, data.get("id") or ""), strip_gender_prefix(data.get("name") or ""), data.get("id") or ""):
			clean = clean_key(value, "")
			if clean and clean not in candidates:
				candidates.append(clean)
		for name in candidates:
			for suffix in (".wav", ".mp3"):
				relative = f"{name}{suffix}"
				try:
					if voice_path_from_relative(relative).is_file():
						return relative
				except Exception:
					continue
		return ""

	def voice_url(relative_path: str, mtime: float = 0) -> str:
		return "/gjj/character_library/voice_file?" + urlencode({
			"path": clean_voice_path(relative_path),
			"mtime": int(mtime or time.time()),
		})

	def unique_character_id(preferred: str, current_id: str = "") -> str:
		base_id = clean_key(strip_gender_prefix(preferred) or preferred or current_id, "character")
		current_id = clean_key(current_id, "")
		if current_id and base_id == current_id:
			return current_id
		if not (root_dir() / base_id).exists():
			return base_id
		for index in range(2, 1000):
			candidate = clean_key(f"{base_id}_{index}", "character")
			if current_id and candidate == current_id:
				return current_id
			if not (root_dir() / candidate).exists():
				return candidate
		return clean_key(f"{base_id}_{uuid.uuid4().hex[:6]}", "character")

	def character_dir(character_id: str) -> Path:
		character_id = clean_key(character_id, "")
		if not character_id:
			raise ValueError("缺少角色 ID。")
		base = root_dir().resolve()
		path = (base / character_id).resolve()
		if base not in path.parents and path != base:
			raise ValueError("角色路径不安全。")
		return path

	def manifest_path(character_id: str) -> Path:
		return character_dir(character_id) / "manifest.json"

	def default_manifest(character_id: str, name: str = "") -> dict:
		t = now_ms()
		return {
			"id": character_id,
			"name": str(name or character_id),
			"notes": "",
			"voice_path": "",
			"created_at": t,
			"updated_at": t,
			"views": [],
		}

	def read_manifest(character_id: str) -> dict:
		path = manifest_path(character_id)
		if not path.is_file():
			return default_manifest(character_id)
		try:
			data = json.loads(path.read_text(encoding="utf-8"))
		except Exception:
			data = {}
		if not isinstance(data, dict):
			data = {}
		data["id"] = str(character_id)
		data["name"] = str(data.get("name") or character_id)
		data["notes"] = str(data.get("notes") or "")
		data["voice_path"] = clean_voice_path(data.get("voice_path") or data.get("voice") or "")
		data["created_at"] = int(data.get("created_at") or now_ms())
		data["updated_at"] = int(data.get("updated_at") or data["created_at"])
		views = []
		for item in data.get("views") if isinstance(data.get("views"), list) else []:
			if not isinstance(item, dict):
				continue
			file_name = clean_key(item.get("file") or "", "")
			if not file_name.lower().endswith(".png"):
				continue
			view_id = clean_key(item.get("id") or Path(file_name).stem, "view")
			views.append({
				"id": view_id,
				"label": str(item.get("label") or view_id),
				"file": file_name,
				"created_at": int(item.get("created_at") or data["created_at"]),
				"updated_at": int(item.get("updated_at") or data["updated_at"]),
			})
		data["views"] = views
		return data

	def write_manifest(data: dict) -> dict:
		character_id = clean_key(data.get("id"), "")
		if not character_id:
			raise ValueError("缺少角色 ID。")
		data["id"] = character_id
		data["name"] = str(data.get("name") or character_id).strip()[:80] or character_id
		data["notes"] = str(data.get("notes") or "")
		data["voice_path"] = clean_voice_path(data.get("voice_path") or "")
		data["updated_at"] = now_ms()
		path = manifest_path(character_id)
		path.parent.mkdir(parents=True, exist_ok=True)
		tmp = path.with_suffix(".json.tmp")
		tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
		os.replace(str(tmp), str(path))
		return read_manifest(character_id)

	def view_url(character_id: str, file_name: str, mtime: float = 0) -> str:
		return "/gjj/character_library/file?" + urlencode({
			"id": character_id,
			"file": file_name,
			"mtime": int(mtime or time.time()),
		})

	def thumbnail_path(character_id: str) -> Path:
		character_id = clean_key(character_id, "")
		if not character_id:
			raise ValueError("缺少角色 ID。")
		base = root_dir().resolve()
		path = (base / f"{character_id}.png").resolve()
		if path.parent != base:
			raise ValueError("角色缩略图路径不安全。")
		return path

	def thumbnail_url(character_id: str) -> str:
		return f"/gjj/character_library/thumbnail/{clean_key(character_id, '')}.png"

	def write_character_thumbnail(character_id: str, source_path: Path) -> bool:
		if not source_path.is_file():
			return False
		target = thumbnail_path(character_id)
		with Image.open(source_path) as source:
			rgba = source.convert("RGBA")
			alpha_bbox = rgba.getchannel("A").point(lambda value: 255 if value > 10 else 0).getbbox()
			if alpha_bbox:
				rgba = rgba.crop(alpha_bbox)
			resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
			thumbnail = ImageOps.fit(rgba, (64, 64), method=resample, centering=(0.5, 0.38))
			tmp = target.with_suffix(".png.tmp")
			thumbnail.save(tmp, format="PNG", optimize=True)
			os.replace(str(tmp), str(target))
		return True

	def sync_character_thumbnail(data: dict, force: bool = False) -> str:
		character_id = clean_key(data.get("id") or "", "")
		if not character_id:
			return ""
		target = thumbnail_path(character_id)
		if target.is_file() and not force:
			return thumbnail_url(character_id)
		views = data.get("views") if isinstance(data.get("views"), list) else []
		def is_head_view(item: dict) -> bool:
			text = f"{item.get('label') or ''} {item.get('id') or ''}".lower()
			return any(keyword in text for keyword in ("大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait"))
		source_view = next((item for item in views if is_head_view(item)), None) or (views[0] if views else None)
		if source_view:
			source_path = character_dir(character_id) / str(source_view.get("file") or "")
			try:
				if write_character_thumbnail(character_id, source_path):
					return thumbnail_url(character_id)
			except Exception as exc:
				print(f"[GJJ] 生成角色缩略图失败（{character_id}）：{exc}")
		return ""

	def enrich_manifest(data: dict) -> dict:
		character_id = data.get("id") or ""
		base = character_dir(character_id)
		views = []
		for item in data.get("views") or []:
			path = base / item.get("file", "")
			if not path.is_file():
				continue
			stat = path.stat()
			next_item = dict(item)
			next_item["size"] = stat.st_size
			next_item["url"] = view_url(character_id, item.get("file", ""), stat.st_mtime)
			views.append(next_item)
		def view_sort_rank(item: dict) -> int:
			text = f"{item.get('label') or ''} {item.get('id') or ''}".lower()
			if any(keyword in text for keyword in ("大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait")):
				return 0
			if any(keyword in text for keyword in ("正面", "正视", "全身", "front")):
				return 1
			if any(keyword in text for keyword in ("侧面", "左侧", "右侧", "侧视", "side", "profile")):
				return 2
			if any(keyword in text for keyword in ("背面", "背部", "后视", "back", "rear")):
				return 3
			return 4
		views.sort(key=view_sort_rank)
		data = dict(data)
		data["views"] = views
		def is_head_view(item: dict) -> bool:
			text = f"{item.get('label') or ''} {item.get('id') or ''}".lower()
			return any(keyword in text for keyword in ("大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait"))
		cover_view = next((item for item in views if is_head_view(item)), None) or (views[0] if views else None)
		data["cover"] = sync_character_thumbnail(data)
		data["cover_view"] = cover_view["id"] if cover_view else ""
		data["reference_name"] = character_reference_name(data, character_id)
		data["reference"] = f"@{data['reference_name']}"
		voice_path = clean_voice_path(data.get("voice_path") or "") or default_voice_path_for_character(data)
		data["voice_path"] = voice_path
		data["voice_url"] = ""
		if voice_path:
			try:
				path = voice_path_from_relative(voice_path)
				if path.is_file():
					data["voice_url"] = voice_url(voice_path, path.stat().st_mtime)
			except Exception:
				data["voice_url"] = ""
		return data

	def list_characters() -> list[dict]:
		items = []
		for entry in root_dir().iterdir():
			if not entry.is_dir():
				continue
			data = enrich_manifest(read_manifest(entry.name))
			if data.get("views") or (entry / "manifest.json").is_file():
				items.append(data)
		return sorted(items, key=lambda item: (-(int(item.get("updated_at") or 0)), str(item.get("name") or "")))

	def character_gender(data: dict) -> str:
		text = f"{data.get('name') or ''} {data.get('id') or ''}"
		if "♀" in text:
			return "female"
		if "♂" in text:
			return "male"
		return "unknown"

	def character_total_size(data: dict) -> int:
		total = 0
		base = character_dir(data.get("id") or "")
		for item in data.get("views") or []:
			try:
				path = base / str(item.get("file") or "")
				if path.is_file():
					total += path.stat().st_size
			except Exception:
				continue
		return total

	def sort_character_records(items: list[dict], sort_mode: str) -> list[dict]:
		mode = str(sort_mode or "updated_desc")
		name_key = lambda item: str(item.get("name") or item.get("id") or "").lower()
		updated_key = lambda item: int(item.get("updated_at") or 0)
		if mode in {"name", "name_asc"}:
			return sorted(items, key=name_key)
		if mode == "name_desc":
			return sorted(items, key=name_key, reverse=True)
		if mode == "updated_asc":
			return sorted(items, key=lambda item: (updated_key(item), name_key(item)))
		if mode in {"size_desc", "views"}:
			return sorted(items, key=lambda item: (-character_total_size(item), -(len(item.get("views") or [])), name_key(item)))
		if mode == "size_asc":
			return sorted(items, key=lambda item: (character_total_size(item), len(item.get("views") or []), name_key(item)))
		return sorted(items, key=lambda item: (-updated_key(item), name_key(item)))

	def list_character_page(page: int = 1, page_size: int = 15, search: str = "", gender: str = "all", sort_mode: str = "updated_desc") -> dict:
		try:
			page = int(page)
		except Exception:
			page = 1
		try:
			page_size = int(page_size)
		except Exception:
			page_size = 15
		page = max(1, page)
		page_size = max(1, min(60, page_size))
		query = str(search or "").strip().lower()
		gender = str(gender or "all")
		items = []
		for entry in root_dir().iterdir():
			if not entry.is_dir():
				continue
			data = read_manifest(entry.name)
			if not data.get("views") and not (entry / "manifest.json").is_file():
				continue
			if gender != "all" and character_gender(data) != gender:
				continue
			if query and query not in f"{data.get('name') or ''} {data.get('id') or ''}".lower():
				continue
			items.append(data)
		items = sort_character_records(items, sort_mode)
		total = len(items)
		page_count = max(1, (total + page_size - 1) // page_size)
		page = max(1, min(page, page_count))
		start = (page - 1) * page_size
		current = [enrich_manifest(item) for item in items[start:start + page_size]]
		return {
			"characters": current,
			"total": total,
			"page": page,
			"page_size": page_size,
			"page_count": page_count,
		}

	def find_character(key: str) -> dict | None:
		text = strip_gender_prefix(str(key or "").strip().lstrip("@"))
		if not text:
			return None
		for item in list_characters():
			if text in {str(item.get("id") or ""), str(item.get("name") or ""), character_reference_name(item)}:
				return item
		lowered = text.lower()
		for item in list_characters():
			if (
				lowered == str(item.get("id") or "").lower()
				or lowered == str(item.get("name") or "").lower()
				or lowered == character_reference_name(item).lower()
			):
				return item
		return None

	def decode_png(value: str) -> bytes:
		text = str(value or "")
		if "," in text and text.lower().startswith("data:"):
			text = text.split(",", 1)[1]
		data = base64.b64decode(text, validate=False)
		if not data.startswith(PNG_SIGNATURE):
			raise ValueError("角色视图必须是透明 PNG 文件。")
		return data

	def decode_image(value: str) -> Image.Image:
		text = str(value or "")
		if "," in text and text.lower().startswith("data:"):
			text = text.split(",", 1)[1]
		raw = base64.b64decode(text, validate=False)
		return Image.open(io.BytesIO(raw)).convert("RGBA")

	def png_bytes(image: Image.Image) -> bytes:
		buffer = io.BytesIO()
		image.convert("RGBA").save(buffer, format="PNG")
		return buffer.getvalue()

	def white_removed_rgba(image: Image.Image) -> Image.Image:
		rgba = image.convert("RGBA")
		width, height = rgba.size
		pixels = rgba.load()
		def brightness_at(x: int, y: int) -> float:
			r, g, b, _a = pixels[x, y]
			return (int(r) + int(g) + int(b)) / 3.0
		def is_background_candidate(x: int, y: int) -> bool:
			r, g, b, a = pixels[x, y]
			if a <= 0:
				return True
			brightness = brightness_at(x, y)
			spread = max(r, g, b) - min(r, g, b)
			return brightness >= 205 and spread <= 52
		background = set()
		queue = []
		for x in range(width):
			for y in (0, height - 1):
				if is_background_candidate(x, y):
					background.add((x, y))
					queue.append((x, y))
		for y in range(height):
			for x in (0, width - 1):
				if (x, y) not in background and is_background_candidate(x, y):
					background.add((x, y))
					queue.append((x, y))
		head = 0
		while head < len(queue):
			x, y = queue[head]
			head += 1
			for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
				if nx < 0 or ny < 0 or nx >= width or ny >= height or (nx, ny) in background:
					continue
				if is_background_candidate(nx, ny):
					background.add((nx, ny))
					queue.append((nx, ny))
		for x, y in background:
			r, g, b, _a = pixels[x, y]
			pixels[x, y] = (r, g, b, 0)
		def clear_dark_rows(from_top: bool) -> None:
			limit = max(2, height // 18)
			rows = range(limit) if from_top else range(height - 1, max(-1, height - limit - 1), -1)
			for y in rows:
				dark = 0
				opaque = 0
				for x in range(width):
					if pixels[x, y][3] > 0:
						opaque += 1
						if brightness_at(x, y) <= 38:
							dark += 1
				if opaque <= 0:
					continue
				if dark / max(1, width) < 0.72:
					break
				for x in range(width):
					r, g, b, _a = pixels[x, y]
					pixels[x, y] = (r, g, b, 0)
		clear_dark_rows(True)
		clear_dark_rows(False)
		alpha = rgba.getchannel("A").filter(ImageFilter.GaussianBlur(radius=0.45))
		rgba.putalpha(alpha)
		return rgba

	def foreground_bbox(image: Image.Image, padding: int = 8) -> tuple[int, int, int, int] | None:
		alpha = image.convert("RGBA").getchannel("A")
		bbox = alpha.point(lambda value: 255 if value > 10 else 0).getbbox()
		if not bbox:
			return None
		left, top, right, bottom = bbox
		return (
			max(0, left - padding),
			max(0, top - padding),
			min(image.width, right + padding),
			min(image.height, bottom + padding),
		)

	def split_white_character_sheet(image: Image.Image) -> list[Image.Image]:
		original = image.convert("RGBA")
		rgba = white_removed_rgba(image)
		alpha = rgba.getchannel("A")
		width, height = rgba.size
		mask = alpha.point(lambda value: 255 if value > 18 else 0)
		columns = []
		y_start = max(0, int(height * 0.035))
		y_end = min(height, int(height * 0.985))
		for x in range(width):
			hit_count = 0
			for y in range(y_start, y_end):
				if mask.getpixel((x, y)):
					hit_count += 1
			columns.append(hit_count)
		min_column_hits = max(6, int(height * 0.018))
		runs: list[tuple[int, int]] = []
		start = None
		for index, count in enumerate(columns):
			if count >= min_column_hits and start is None:
				start = index
			elif count < min_column_hits and start is not None:
				if index - start >= max(18, width // 80):
					runs.append((start, index))
				start = None
		if start is not None and width - start >= max(18, width // 80):
			runs.append((start, width))

		merged: list[tuple[int, int]] = []
		gap_limit = max(12, width // 55)
		for left, right in runs:
			if merged and left - merged[-1][1] <= gap_limit:
				merged[-1] = (merged[-1][0], right)
			else:
				merged.append((left, right))

		items = []
		for left, right in merged:
			if right - left < max(24, width // 40):
				continue
			crop = rgba.crop((left, 0, right, height))
			box = foreground_bbox(crop, padding=max(6, width // 160))
			if not box:
				continue
			cut = crop.crop(box)
			if cut.width * cut.height < max(900, width * height * 0.004):
				continue
			items.append((left, original.crop((left + box[0], box[1], left + box[2], box[3]))))
		if not items:
			box = foreground_bbox(rgba, padding=8)
			return [original.crop(box)] if box else [original]
		return [item[1] for item in sorted(items, key=lambda entry: entry[0])]

	def split_transparent_character_sheet(image: Image.Image) -> list[Image.Image]:
		rgba = image.convert("RGBA")
		alpha = rgba.getchannel("A")
		width, height = rgba.size
		mask = alpha.point(lambda value: 255 if value > 12 else 0)
		columns = []
		y_start = max(0, int(height * 0.02))
		y_end = min(height, int(height * 0.99))
		for x in range(width):
			hit_count = 0
			for y in range(y_start, y_end):
				if mask.getpixel((x, y)):
					hit_count += 1
			columns.append(hit_count)
		min_column_hits = max(4, int(height * 0.012))
		runs: list[tuple[int, int]] = []
		start = None
		for index, count in enumerate(columns):
			if count >= min_column_hits and start is None:
				start = index
			elif count < min_column_hits and start is not None:
				if index - start >= max(16, width // 90):
					runs.append((start, index))
				start = None
		if start is not None and width - start >= max(16, width // 90):
			runs.append((start, width))

		merged: list[tuple[int, int]] = []
		gap_limit = max(10, width // 70)
		for left, right in runs:
			if merged and left - merged[-1][1] <= gap_limit:
				merged[-1] = (merged[-1][0], right)
			else:
				merged.append((left, right))

		items = []
		for left, right in merged:
			crop = rgba.crop((left, 0, right, height))
			box = foreground_bbox(crop, padding=max(6, width // 180))
			if not box:
				continue
			cut = crop.crop(box)
			if cut.width * cut.height < max(700, width * height * 0.003):
				continue
			items.append((left, cut))
		if not items:
			box = foreground_bbox(rgba, padding=8)
			return [rgba.crop(box)] if box else [rgba]
		return [item[1] for item in sorted(items, key=lambda entry: entry[0])]

	def fit_rgb_canvas(image: Image.Image, size: int = 1024) -> Image.Image:
		src = image.convert("RGB")
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		src.thumbnail((size, size), resample)
		canvas = Image.new("RGB", (size, size), (245, 245, 245))
		left = (size - src.width) // 2
		top = (size - src.height) // 2
		canvas.paste(src, (left, top))
		return canvas

	def fit_rgb_canvas_to_size(image: Image.Image, width: int, height: int) -> Image.Image:
		src = image.convert("RGB")
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		src.thumbnail((max(8, int(width)), max(8, int(height))), resample)
		canvas = Image.new("RGB", (max(8, int(width)), max(8, int(height))), (245, 245, 245))
		left = (canvas.width - src.width) // 2
		top = (canvas.height - src.height) // 2
		canvas.paste(src, (left, top))
		return canvas

	def prepare_matting_rgb_batch(images: list[Image.Image]) -> list[Image.Image]:
		if not images:
			return []
		sizes = [(image.width, image.height) for image in images]
		if len(set(sizes)) == 1:
			return [image.convert("RGB") for image in images]
		width = max(8, max(item[0] for item in sizes))
		height = max(8, max(item[1] for item in sizes))
		return [fit_rgb_canvas_to_size(image, width, height) for image in images]

	def fit_character_reference_canvas(image: Image.Image, width: int = 1024, height: int = 1280) -> Image.Image:
		rgba = image.convert("RGBA")
		source = Image.new("RGB", rgba.size, (255, 255, 255))
		source.paste(rgba.convert("RGB"), mask=rgba.getchannel("A"))
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		source.thumbnail((int(width), int(height)), resample)
		canvas = Image.new("RGB", (int(width), int(height)), (255, 255, 255))
		left = (canvas.width - source.width) // 2
		top = (canvas.height - source.height) // 2
		canvas.paste(source, (left, top))
		return canvas

	def make_character_reference_collage(images: list[Image.Image]) -> Image.Image:
		clean_images = [image.convert("RGBA") for image in images if image is not None]
		if not clean_images:
			raise RuntimeError("没有可用于拼图的参考图。")
		if len(clean_images) == 1:
			return clean_images[0]
		count = len(clean_images)
		cols = max(1, int((count ** 0.5) + 0.999))
		rows = max(1, (count + cols - 1) // cols)
		max_w = max(image.width for image in clean_images)
		max_h = max(image.height for image in clean_images)
		cell = max(256, min(1024, max(max_w, max_h)))
		gap = max(12, cell // 32)
		out_w = cols * cell + (cols + 1) * gap
		out_h = rows * cell + (rows + 1) * gap
		canvas = Image.new("RGB", (out_w, out_h), (255, 255, 255))
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		for index, image in enumerate(clean_images):
			src = image.copy()
			src.thumbnail((cell, cell), resample)
			x = gap + (index % cols) * (cell + gap) + (cell - src.width) // 2
			y = gap + (index // cols) * (cell + gap) + (cell - src.height) // 2
			if src.mode == "RGBA":
				background = Image.new("RGB", src.size, (255, 255, 255))
				background.paste(src.convert("RGB"), mask=src.getchannel("A"))
				src = background
			else:
				src = src.convert("RGB")
			canvas.paste(src, (x, y))
		return canvas

	def comprehensive_matting_cutouts(images: list[Image.Image]) -> list[Image.Image]:
		try:
			from .nodes.gjj_comprehensive_matting import (
				GJJ_ComprehensiveMatting,
				METHOD_RMBG14,
				METHODS,
				MODEL_DOWNLOAD_URL,
				_pil_list_to_tensor,
				_resolve_model_path,
				_tensor_to_pil_list,
			)
		except Exception as exc:
			raise RuntimeError(f"加载综合抠图运行时失败：{exc}") from exc
		character_settings = _gjj_section_settings("character_library")
		matting_method = str(character_settings.get("matting_method") or METHOD_RMBG14)
		if matting_method not in METHODS:
			matting_method = METHOD_RMBG14
		try:
			_resolve_model_path(matting_method, notify_missing=False)
		except Exception as exc:
			raise RuntimeError(f"未找到“{matting_method}”所需的抠图模型。{exc}\n{MODEL_DOWNLOAD_URL}") from exc
		rgb_images = prepare_matting_rgb_batch(images)
		context_unique_id = "gjj_character_library_import"
		had_last_prompt_id = hasattr(server, "last_prompt_id")
		if not had_last_prompt_id:
			try:
				setattr(server, "last_prompt_id", context_unique_id)
			except Exception:
				pass
		try:
			output = GJJ_ComprehensiveMatting().remove_background(
				matting_method=matting_method,
				background="透明",
				device="自动",
				process_res=1024,
				threshold=0.0,
				mask_blur=0.0,
				invert_output=False,
				inspyrenet_jit=False,
				media=_pil_list_to_tensor(rgb_images),
				prompt={},
				extra_pnginfo={},
				unique_id=context_unique_id,
			)
		finally:
			if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
				try:
					delattr(server, "last_prompt_id")
				except Exception:
					pass
		result = output.get("result") if isinstance(output, dict) else None
		if not result or len(result) < 1:
			raise RuntimeError("综合抠图没有返回图像结果。")
		rgba_images = [image.convert("RGBA") for image in _tensor_to_pil_list(result[0])]
		result = []
		for rgba in rgba_images:
			box = foreground_bbox(rgba, padding=8)
			result.append(rgba.crop(box) if box else rgba)
		return result

	def labels_for_split(count: int) -> list[str]:
		if count <= 1:
			return ["大头照"]
		if count == 2:
			return ["大头照", "正面"]
		if count == 3:
			return ["大头照", "正面", "背面"]
		if count == 4:
			return ["大头照", "正面", "45度", "背面"]
		base = ["大头照", "正面", "左侧", "右侧", "背面", "45度", "半身", "动作"]
		return [base[index] if index < len(base) else f"视图{index + 1}" for index in range(count)]

	def labels_for_multiview(count: int) -> list[str]:
		base = ["侧面", "背面"]
		return [base[index] if index < len(base) else f"视图{index + 1}" for index in range(count)]

	def parse_view_labels(value) -> list[str]:
		raw = []
		if isinstance(value, list):
			raw = value
		else:
			text = str(value or "").strip()
			if text:
				try:
					parsed = json.loads(text)
					raw = parsed if isinstance(parsed, list) else [text]
				except Exception:
					raw = re.split(r"[,，、\n;；]+", text)
		labels = []
		for item in raw:
			label = str(item or "").strip()
			if label and label not in labels:
				labels.append(label[:80])
		return labels

	def find_character_head_view(manifest: dict) -> dict | None:
		views = manifest.get("views") if isinstance(manifest.get("views"), list) else []
		keywords = ("大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait")
		for view in views:
			text = f"{view.get('label') or ''} {view.get('id') or ''}".lower()
			if any(keyword.lower() in text for keyword in keywords):
				return view
		return None

	def find_character_view_by_label(manifest: dict, label: str) -> dict | None:
		key = str(label or "").strip().lower()
		if not key:
			return None
		views = manifest.get("views") if isinstance(manifest.get("views"), list) else []
		for view in views:
			candidates = (
				str(view.get("label") or "").strip().lower(),
				str(view.get("id") or "").strip().lower(),
				str(view.get("file") or "").strip().lower(),
			)
			if key in candidates:
				return view
		return None

	def open_character_view_image(character_id: str, view: dict) -> Image.Image:
		file_name = clean_key(view.get("file") or "", "")
		if not file_name:
			raise ValueError("角色视图缺少文件。")
		path = (character_dir(character_id) / file_name).resolve()
		if character_dir(character_id).resolve() not in path.parents or not path.is_file():
			raise ValueError("角色视图文件不存在。")
		return Image.open(path).convert("RGBA")

	def multiview_prompt_for_label(label: str) -> str:
		text = str(label or "").strip()
		lowered = text.lower()
		view_rule = "标准正面视图"
		if "左前" in text or "front left" in lowered or "left front" in lowered:
			view_rule = "左前 45° 斜侧视图，身体和脸部朝向左前方"
		elif "右前" in text or "front right" in lowered or "right front" in lowered:
			view_rule = "右前 45° 斜侧视图，身体和脸部朝向右前方"
		elif "左后" in text or "back left" in lowered or "left back" in lowered:
			view_rule = "左后 45° 斜后视图，展示背部轮廓和左侧轮廓"
		elif "右后" in text or "back right" in lowered or "right back" in lowered:
			view_rule = "右后 45° 斜后视图，展示背部轮廓和右侧轮廓"
		elif "左侧" in text or "left" in lowered:
			view_rule = "左侧面视图，主体完整侧身"
		elif "右侧" in text or "right" in lowered:
			view_rule = "右侧面视图，主体完整侧身"
		elif "侧" in text or "side" in lowered:
			view_rule = "标准侧面视图，主体完整侧身"
		elif "背" in text or "后" in text or "back" in lowered:
			view_rule = "背面/后视图，主体背对镜头"
		elif "底部仰视" in text:
			view_rule = "底部仰视视角，从下往上看主体"
		elif "顶部俯视" in text:
			view_rule = "顶部俯视视角，从上往下看主体"
		elif "正面" in text or "front" in lowered:
			view_rule = "标准正面视图，主体面向镜头"

		shot_rule = "远景全身照，完整全身构图，从头顶到双脚全部可见，全身无裁剪，双脚完整在画面内"
		is_headshot = any(token in text for token in ("大头照", "大头", "头像", "头部", "脸")) or any(
			token in lowered for token in ("headshot", "head shot", "face portrait")
		)
		if is_headshot:
			shot_rule = "大头特写，近距离头肩肖像，只构图头部、颈部和双肩，画面下缘不超过胸口，禁止出现腰部、腿、脚或鞋"
		elif "微距" in text or "macro" in lowered:
			shot_rule = "微距细节特写，只拍摄脸部或服装局部细节，画面极近，纹理清晰"
		elif "大特写" in text or "extreme close" in lowered:
			shot_rule = "大特写肖像构图，只包含脸部主要区域和少量头部边缘，五官清晰"
		elif "特写" in text or "close" in lowered:
			shot_rule = "特写肖像构图，只拍头部和肩颈附近，五官、头饰和表情清晰"
		elif "肩部肖像" in text or "shoulder" in lowered:
			shot_rule = "肩部肖像构图，只包含头部、颈部和双肩，上半身不超过胸口，五官清晰"
		elif "半身" in text or "half" in lowered or "中近景" in text:
			shot_rule = "半身或中近景构图，显示头部到腰部/胸腹区域，清晰保留服装上半身"
		elif "中景" in text:
			shot_rule = "中景构图，显示主体上半身到大腿附近，姿态和服装清晰"
		elif "中远景" in text:
			shot_rule = "中远景构图，显示大部分身体，允许轻微留白，主体姿态清晰"
		elif "全身肖像" in text or "大全景" in text or "远景" in text or "广角" in text:
			shot_rule = "全身肖像/远景构图，从头到脚完整可见，画面留有适度空间"

		angle_rule = "齐眼平视，镜头高度与人物眼睛接近"
		if "超低仰拍" in text:
			angle_rule = "超低机位仰拍，镜头明显低于人物"
		elif "仰拍" in text:
			angle_rule = "低机位仰拍，镜头略低于人物"
		elif "微高角度" in text:
			angle_rule = "微高角度，镜头略高于人物眼睛"
		elif "高空鸟瞰" in text:
			angle_rule = "高空鸟瞰角度，从很高位置向下看"
		elif "极致俯拍" in text:
			angle_rule = "极致俯拍，镜头几乎从正上方向下"
		elif "俯拍" in text or "高角度" in text:
			angle_rule = "高角度俯拍，镜头高于人物向下看"
		elif "倾斜镜头" in text:
			angle_rule = "倾斜镜头构图，画面轻微 Dutch angle"

		if is_headshot or any(token in lowered for token in ("head", "face", "portrait")):
			return f"白色背景,大头特写,{view_rule},{shot_rule},{angle_rule},构图紧凑，清晰保留完整面部特征，人物资产。"
		if "动作" in text or "pose" in lowered or "action" in lowered:
			return f"白色背景,{text}人物动作视图,{view_rule},{shot_rule},{angle_rule},动作清晰自然，保持身份、服装配色和风格一致。"
		return f"白色背景,{text or '自定义角度'}人物视图,{view_rule},{shot_rule},{angle_rule},保持身份、五官、服装配色和风格一致。"

	def save_view_bytes(character_id: str, label: str, raw: bytes) -> dict:
		if not raw.startswith(PNG_SIGNATURE):
			raise ValueError("角色视图必须是 PNG 文件。")
		manifest = read_manifest(character_id)
		view_id = clean_key(label, "view")
		file_name = f"{view_id}.png"
		base = character_dir(character_id)
		base.mkdir(parents=True, exist_ok=True)
		path = (base / file_name).resolve()
		if base.resolve() not in path.parents:
			raise ValueError("视图路径不安全。")
		with open(path, "wb") as handle:
			handle.write(raw)
		t = now_ms()
		views = [item for item in manifest.get("views", []) if item.get("id") != view_id and item.get("file") != file_name]
		views.append({
			"id": view_id,
			"label": str(label or view_id).strip()[:80] or view_id,
			"file": file_name,
			"created_at": t,
			"updated_at": t,
		})
		manifest["views"] = views
		manifest = write_manifest(manifest)
		if any(keyword in f"{label} {view_id}".lower() for keyword in ("大头照", "大头", "头像", "头部", "脸", "face", "head", "portrait")):
			sync_character_thumbnail(manifest, force=True)
		elif not thumbnail_path(character_id).is_file():
			sync_character_thumbnail(manifest)
		return manifest

	def save_view_image(character_id: str, label: str, image: Image.Image) -> dict:
		rgba = image.convert("RGBA")
		alpha = rgba.getchannel("A").point(lambda value: 255 if value > 10 else 0)
		bbox = alpha.getbbox()
		if bbox:
			subject_width = max(0, bbox[2] - bbox[0])
			subject_height = max(0, bbox[3] - bbox[1])
		else:
			subject_width, subject_height = rgba.size
		if str(label or "").strip() == "自动分类":
			if subject_width >= subject_height:
				resolved_label = "大头照"
			elif subject_height >= subject_width * 1.6:
				resolved_label = "全身"
			else:
				resolved_label = "人物资产"
		else:
			resolved_label = "大头照" if subject_width >= subject_height else label
		return save_view_bytes(character_id, resolved_label, png_bytes(rgba))

	@server.routes.get("/gjj/character_library/list")
	async def gjj_character_library_list(request):
		if "page" in request.query or "page_size" in request.query:
			result = list_character_page(
				request.query.get("page") or 1,
				request.query.get("page_size") or 15,
				request.query.get("search") or "",
				request.query.get("gender") or "all",
				request.query.get("sort") or "updated_desc",
			)
			return web.json_response({
				"ok": True,
				"directory": str(root_dir()),
				**result,
			})
		return web.json_response({
			"ok": True,
			"directory": str(root_dir()),
			"characters": list_characters(),
		})

	@server.routes.get("/gjj/character_library/model_tree")
	async def gjj_character_library_model_tree(_request):
		settings = _gjj_section_settings("character_library")
		choices = _gjj_library_model_choices()
		try:
			import comfy.samplers
			sampler_names = ["自动", *list(comfy.samplers.KSampler.SAMPLERS)]
			scheduler_names = ["自动", *list(comfy.samplers.KSampler.SCHEDULERS)]
		except Exception:
			sampler_names = ["自动", "euler", "dpmpp_2m", "dpmpp_2m_sde", "lcm"]
			scheduler_names = ["自动", "simple", "normal", "karras", "exponential", "sgm_uniform"]
		matting_method = str(settings.get("matting_method") or "RMBG1.4")
		matting_model_paths = {
			"RMBG1.4": "models/RMBG/rmbg1.4.safetensors",
			"RMBG2": "models/RMBG/rmbg2.safetensors",
			"官方背景移除": "models/background_removal/BiRefNet.safetensors",
			"BiRefNet 通用": "models/BiRefNet/General.safetensors",
			"BiRefNet 精细": "models/BiRefNet/Matting.safetensors",
			"BEN2": "models/RMBG/BEN2/BEN2_Base.pth",
			"Inspyrenet": "models/RMBG/InSPyReNet_SwinB.pth",
		}
		return web.json_response({
			"ok": True,
			"title": "角色库模型树",
			"settings_section": "character_library",
			"settings": settings,
			"generation_controls": [
				{"key": "sampling_sampler", "label": "采样器", "type": "select", "options": sampler_names},
				{"key": "sampling_scheduler", "label": "调度器", "type": "select", "options": scheduler_names},
				{"key": "sampling_steps", "label": "采样步数", "type": "number", "min": 0, "max": 100, "step": 1, "hint": "0 = 自动"},
				{"key": "sampling_cfg", "label": "CFG", "type": "number", "min": -1, "max": 30, "step": 0.1, "hint": "-1 = 自动"},
				{"key": "sampling_denoise", "label": "降噪强度", "type": "number", "min": -1, "max": 1, "step": 0.01, "hint": "-1 = 自动"},
				{"key": "sampling_seed", "label": "种子", "type": "number", "min": 0, "max": 4294967295, "step": 1},
				{"key": "keep_model", "label": "生成后保持模型", "type": "boolean"},
			],
			"controls": [
				{"key": "matting_method", "label": "抠图模型", "options": choices.get("matting_methods") or ["RMBG1.4"]},
				{"key": "multiview_unet", "label": "多视图 UNET", "options": choices.get("diffusion_models") or []},
				{"key": "multiview_clip", "label": "多视图 CLIP / VL", "options": choices.get("text_encoders") or []},
				{"key": "multiview_vae", "label": "多视图 VAE", "options": choices.get("vae") or []},
				{"key": "multiview_lora_1", "label": "Lightning LoRA", "options": choices.get("loras") or []},
				{"key": "multiview_lora_2", "label": "多角度 LoRA", "options": choices.get("loras") or []},
				{"key": "annotate_clip", "label": "备注/性别文本编码器", "options": choices.get("text_encoders") or []},
			],
			"groups": [
				{
					"name": "🪄 抠图",
					"items": [
						{
							"label": f"抠图模型：{matting_method}",
							"path": matting_model_paths.get(matting_method, f"models/RMBG/{matting_method}"),
						},
					],
				},
				{
					"name": "🚀 生成多视图",
					"items": [
						{"label": "UNET", "path": f"models/diffusion_models/{settings.get('multiview_unet') or 'qwen_image_edit_2511_int4_convrot.safetensors'}"},
						{"label": "CLIP / VL", "path": f"models/text_encoders/{settings.get('multiview_clip') or 'qwen_2.5_vl_7b_int4_convrot.safetensors'}"},
						{"label": "VAE", "path": f"models/vae/{settings.get('multiview_vae') or 'qwen_image_vae.safetensors'}"},
						{"label": "Lightning LoRA", "path": f"models/loras/{settings.get('multiview_lora_1') or 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'}"},
						{"label": "多角度 LoRA", "path": f"models/loras/{settings.get('multiview_lora_2') or 'qwen-image-edit-2511-multiple-angles-lora.safetensors'}"},
					],
				},
				{
					"name": "🧠 备注/性别推理",
					"items": [
						{"label": "Gemma / Qwen VL 文本编码器", "path": f"models/text_encoders/{settings.get('annotate_clip') or 'qwen3.5_4b_fp8_mixed.safetensors'}"},
					],
				},
				{
					"name": "👤 人物库存储",
					"items": [
						{"label": "角色库", "path": str(root_dir()), "folder": True},
					],
				},
			],
		})

	@server.routes.post("/gjj/character_library/character")
	async def gjj_character_library_character(request):
		try:
			data = await request.json()
			name = str(data.get("name") or "").strip()
			requested_id = clean_key(data.get("id") or "", "")
			character_id = requested_id or unique_character_id(name or uuid.uuid4().hex[:10])
			manifest = read_manifest(character_id)
			manifest["name"] = name or manifest.get("name") or character_id
			manifest["notes"] = str(data.get("notes") if data.get("notes") is not None else manifest.get("notes") or "")
			if "voice_path" in data:
				manifest["voice_path"] = clean_voice_path(data.get("voice_path") or "")
			if requested_id and name:
				next_id = unique_character_id(name, requested_id)
				if next_id != requested_id:
					old_path = character_dir(requested_id)
					new_path = character_dir(next_id)
					old_thumbnail = thumbnail_path(requested_id)
					new_thumbnail = thumbnail_path(next_id)
					if old_path.exists():
						if new_path.exists():
							raise ValueError(f"角色文件夹已存在：{next_id}")
						old_path.rename(new_path)
					if old_thumbnail.is_file():
						if new_thumbnail.exists():
							new_thumbnail.unlink()
						old_thumbnail.rename(new_thumbnail)
					manifest["id"] = next_id
					character_id = next_id
			return web.json_response({"ok": True, "character": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/voice")
	async def gjj_character_library_voice(request):
		try:
			content_type = str(request.content_type or "")
			if "multipart" not in content_type:
				data = await request.json()
				character_id = clean_key(data.get("id") or "", "")
				manifest = read_manifest(character_id)
				manifest["voice_path"] = clean_voice_path(data.get("voice_path") or "")
				return web.json_response({"ok": True, "character": enrich_manifest(write_manifest(manifest))})
			reader = await request.multipart()
			fields = {}
			raw = b""
			file_name = ""
			while True:
				part = await reader.next()
				if part is None:
					break
				if part.name == "file":
					file_name = str(part.filename or "")
					raw = await part.read(decode=False)
				else:
					fields[part.name] = await part.text()
			character_id = clean_key(fields.get("id") or "", "")
			manifest = read_manifest(character_id)
			if not raw:
				raise ValueError("缺少音色文件。")
			suffix = Path(file_name).suffix.lower()
			if suffix not in {".wav", ".mp3"}:
				raise ValueError("音色默认使用 wav，同时兼容 mp3 文件。")
			target_name = clean_key(fields.get("voice_path") or file_name or f"{character_reference_name(manifest, character_id)}.wav", "voice.wav")
			if Path(target_name).suffix.lower() not in {".wav", ".mp3"}:
				target_name += suffix or ".wav"
			target_path = voice_path_from_relative(target_name)
			target_path.parent.mkdir(parents=True, exist_ok=True)
			target_path.write_bytes(raw)
			manifest["voice_path"] = clean_voice_path(target_name)
			return web.json_response({"ok": True, "character": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/character_library/voice_list")
	async def gjj_character_library_voice_list(request):
		try:
			search = str(request.query.get("search") or "").strip().lower()
			items = []
			base = voice_root_dir()
			for path in sorted((item for item in base.rglob("*") if item.is_file() and item.suffix.lower() in {".wav", ".mp3"}), key=lambda item: str(item.relative_to(base)).lower()):
				try:
					relative = str(path.relative_to(base)).replace("\\", "/")
				except Exception:
					continue
				if search and search not in relative.lower() and search not in path.stem.lower():
					continue
				stat = path.stat()
				items.append({
					"path": relative,
					"name": path.name,
					"size": stat.st_size,
					"mtime": stat.st_mtime,
					"url": voice_url(relative, stat.st_mtime),
				})
				if len(items) >= 500:
					break
			return web.json_response({"ok": True, "root": str(base), "items": items})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc), "items": []}, status=400)

	@server.routes.delete("/gjj/character_library/character")
	async def gjj_character_library_delete_character(request):
		try:
			character_id = request.query.get("id") or ""
			path = character_dir(character_id)
			if path.exists():
				shutil.rmtree(path)
			thumbnail_path(character_id).unlink(missing_ok=True)
			return web.json_response({"ok": True})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/view")
	async def gjj_character_library_view(request):
		try:
			content_type = str(request.content_type or "")
			if "multipart" in content_type:
				reader = await request.multipart()
				fields = {}
				raw = b""
				while True:
					part = await reader.next()
					if part is None:
						break
					if part.name == "file":
						raw = await part.read(decode=False)
					else:
						fields[part.name] = await part.text()
				character_id = clean_key(fields.get("id") or fields.get("character_id") or fields.get("name"), "character")
				name = str(fields.get("name") or character_id)
				label = str(fields.get("label") or fields.get("view") or "正面")
				image = Image.open(io.BytesIO(raw)).convert("RGBA")
			else:
				data = await request.json()
				character_id = clean_key(data.get("id") or data.get("character_id") or data.get("name"), "character")
				name = str(data.get("name") or character_id)
				label = str(data.get("label") or data.get("view") or "正面")
				image = decode_image(data.get("image") or data.get("png") or "")
			manifest = read_manifest(character_id)
			manifest["name"] = name or manifest.get("name") or character_id
			write_manifest(manifest)
			matted = comprehensive_matting_cutouts([image])
			view_image = matted[0] if matted else image
			return web.json_response({"ok": True, "character": enrich_manifest(save_view_image(character_id, label, view_image))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/view_label")
	async def gjj_character_library_view_label(request):
		try:
			data = await request.json()
			character_id = clean_key(data.get("id") or data.get("character_id") or "", "")
			view_id = clean_key(data.get("view") or data.get("view_id") or "", "")
			label = str(data.get("label") or "").strip()[:80]
			if not character_id or not view_id:
				raise ValueError("缺少角色或视图 ID。")
			if not label:
				raise ValueError("视图标签不能为空。")
			manifest = read_manifest(character_id)
			changed = False
			for item in manifest.get("views") or []:
				if item.get("id") == view_id:
					item["label"] = label
					item["updated_at"] = now_ms()
					changed = True
					break
			if not changed:
				raise ValueError("没有找到要修改的视图。")
			manifest = write_manifest(manifest)
			sync_character_thumbnail(manifest, force=True)
			return web.json_response({"ok": True, "character": enrich_manifest(manifest)})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/import_sheet")
	async def gjj_character_library_import_sheet(request):
		try:
			content_type = str(request.content_type or "")
			if "multipart" in content_type:
				reader = await request.multipart()
				fields = {}
				raw = b""
				while True:
					part = await reader.next()
					if part is None:
						break
					if part.name == "file":
						raw = await part.read(decode=False)
					else:
						fields[part.name] = await part.text()
				name = str(fields.get("name") or "").strip()
				character_id = clean_key(fields.get("id") or name, "character")
				image = Image.open(io.BytesIO(raw)).convert("RGBA")
			else:
				data = await request.json()
				name = str(data.get("name") or "").strip()
				character_id = clean_key(data.get("id") or name, "character")
				image = decode_image(data.get("image") or data.get("png") or "")
			manifest = read_manifest(character_id)
			manifest["name"] = name or manifest.get("name") or character_id
			write_manifest(manifest)
			matted_sheets = comprehensive_matting_cutouts([image])
			views = split_transparent_character_sheet(matted_sheets[0] if matted_sheets else image)
			labels = labels_for_split(len(views))
			for label, view in zip(labels, views):
				save_view_image(character_id, label, view)
			return web.json_response({
				"ok": True,
				"count": len(views),
				"labels": labels,
				"character": enrich_manifest(read_manifest(character_id)),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/generate_multiview")
	async def gjj_character_library_generate_multiview(request):
		try:
			content_type = str(request.content_type or "")
			if "multipart" in content_type:
				reader = await request.multipart()
				fields = {}
				raw = b""
				action_raws = []
				while True:
					part = await reader.next()
					if part is None:
						break
					if part.name == "file":
						raw = await part.read(decode=False)
					elif str(part.name or "").startswith("action_file"):
						action_raw = await part.read(decode=False)
						if action_raw:
							action_raws.append(action_raw)
					else:
						fields[part.name] = await part.text()
				name = str(fields.get("name") or "").strip()
				character_id = clean_key(fields.get("id") or name, "character")
				image = Image.open(io.BytesIO(raw)).convert("RGBA") if raw else None
				action_images = [Image.open(io.BytesIO(item)).convert("RGBA") for item in action_raws]
				base_prompt = str(fields.get("base_prompt") or "").strip()
				reference_label = str(fields.get("reference_label") or "").strip()
				reference_labels = parse_view_labels(fields.get("reference_labels") or "")
				if reference_label and reference_label not in reference_labels:
					reference_labels.insert(0, reference_label)
				requested_labels = parse_view_labels(fields.get("labels") or fields.get("views") or "")
				prompt_labels = parse_view_labels(fields.get("prompt_labels") or "")
				split_generated_sheet = str(fields.get("split_generated_sheet") or "").strip().lower() in {"1", "true", "yes", "on"}
				multiview_unet_override = str(fields.get("multiview_unet") or "").strip()
				multiview_clip_override = str(fields.get("multiview_clip") or "").strip()
				multiview_vae_override = str(fields.get("multiview_vae") or "").strip()
				multiview_lora_1_override = str(fields.get("multiview_lora_1") or "").strip()
				multiview_lora_2_override = str(fields.get("multiview_lora_2") or "").strip()
				multiview_lora_3_override = str(fields.get("multiview_lora_3") or "").strip()
				rmbg_model_override = str(fields.get("rmbg_model") or "").strip()
				seed = int(fields.get("seed") or 0)
			else:
				data = await request.json()
				name = str(data.get("name") or "").strip()
				character_id = clean_key(data.get("id") or name, "character")
				image_value = data.get("image") or data.get("png") or ""
				image = decode_image(image_value) if image_value else None
				action_images = []
				base_prompt = str(data.get("base_prompt") or "").strip()
				reference_label = str(data.get("reference_label") or "").strip()
				reference_labels = parse_view_labels(data.get("reference_labels") or "")
				if reference_label and reference_label not in reference_labels:
					reference_labels.insert(0, reference_label)
				requested_labels = parse_view_labels(data.get("labels") or data.get("views") or "")
				prompt_labels = parse_view_labels(data.get("prompt_labels") or "")
				split_generated_sheet = str(data.get("split_generated_sheet") or "").strip().lower() in {"1", "true", "yes", "on"}
				multiview_unet_override = str(data.get("multiview_unet") or "").strip()
				multiview_clip_override = str(data.get("multiview_clip") or "").strip()
				multiview_vae_override = str(data.get("multiview_vae") or "").strip()
				multiview_lora_1_override = str(data.get("multiview_lora_1") or "").strip()
				multiview_lora_2_override = str(data.get("multiview_lora_2") or "").strip()
				multiview_lora_3_override = str(data.get("multiview_lora_3") or "").strip()
				rmbg_model_override = str(data.get("rmbg_model") or "").strip()
				seed = int(data.get("seed") or 0)
			manifest = read_manifest(character_id)
			manifest["name"] = name or manifest.get("name") or character_id
			write_manifest(manifest)
			uploaded_reference_image = image.copy() if image is not None else None
			preserved_headshot = None
			reference_count = 1
			if image is None:
				reference_images = []
				missing_reference_labels = []
				for label in reference_labels:
					reference_view = find_character_view_by_label(manifest, label)
					if reference_view is None:
						missing_reference_labels.append(label)
						continue
					reference_images.append(open_character_view_image(character_id, reference_view))
				if missing_reference_labels:
					raise RuntimeError(f"未找到参考图视图：{'、'.join(missing_reference_labels)}")
				if not reference_images:
					reference_view = find_character_head_view(manifest)
					if reference_view is not None:
						reference_images.append(open_character_view_image(character_id, reference_view))
				if not reference_images:
					raise RuntimeError("缺少大头照：请先添加“大头照”视图，再用它自动生成其它角度。")
				reference_count = len(reference_images)
				image = make_character_reference_collage(reference_images)

			if uploaded_reference_image is not None:
				matted_references = comprehensive_matting_cutouts([uploaded_reference_image])
				if matted_references:
					reference_rgba = matted_references[0].convert("RGBA")
					reference_bbox = reference_rgba.getchannel("A").point(lambda value: 255 if value > 10 else 0).getbbox()
					if reference_bbox:
						reference_width = reference_bbox[2] - reference_bbox[0]
						reference_height = reference_bbox[3] - reference_bbox[1]
						if reference_width >= reference_height:
							preserved_headshot = reference_rgba
							save_view_image(character_id, "大头照", reference_rgba)

			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor, _tensor_to_pil_list
				from .nodes.gjj_character_multiview_studio import (
					DEFAULT_EXTRA_PROMPT,
					DEFAULT_MULTI_ANGLES_LORA,
					DEFAULT_NEGATIVE_PROMPT,
					DEFAULT_QWEN2511_LIGHTNING_LORA,
					DEFAULT_QWEN2511_UNET,
					GJJ_CharacterMultiViewStudio,
					_is_qwen2511_unet_name,
					_pick_qwen2511_unet_name,
					_pick_available_lora_name,
					_safe_filename_list,
				)
				from .nodes.common_utils.model_manager import (
					gjjutils_find_model_list,
					gjjutils_model_stem_without_quant,
					gjjutils_resolve_model_by_extensionless_seed,
				)
				from .nodes.common_utils.model_family import (
					gjjutils_match_model_family_preset,
					gjjutils_model_family_pick_lora_name,
					gjjutils_model_family_pick_model_name,
				)
			except Exception as exc:
				raise RuntimeError(f"加载 GJJ_CharacterMultiViewStudio 运行时失败：{exc}") from exc

			def default_widget_value(key: str, fallback):
				try:
					spec = GJJ_CharacterMultiViewStudio.INPUT_TYPES()["required"].get(key)
					if isinstance(spec, tuple) and len(spec) > 1 and isinstance(spec[1], dict):
						return spec[1].get("default", fallback)
				except Exception:
					pass
				return fallback

			if reference_count > 1:
				identity_prompt = (
					"图一是一张由同一角色多张参考图拼成的参考板，只用于人物身份、五官、发型、服装配色、正反面细节和整体风格参考；"
					"不要把参考板画成最终画面的拼图、分格、多人物或文字标签，也不要继承参考板的白底、边框、裁切范围和镜头距离。"
					"每个输出视图必须严格服从对应动作文本里的视角、景别和镜头角度。"
				)
			elif requested_labels:
				identity_prompt = (
					"图一只作为人物身份、五官、发型、服装配色和风格参考；不要继承图一的裁切范围、白条、背景边缘或镜头距离。"
					"每个输出视图必须严格服从对应动作文本里的视角、景别和镜头角度；如果写了肩部肖像、半身、特写或俯仰角，不要自动改成全身正面。"
				)
			else:
				identity_prompt = (
					"图一只作为人物身份、五官、发型、服装配色和风格参考；不要继承图一的近景构图、裁切范围、白条、背景边缘或镜头距离。"
					"除大头照外，其余视图必须重新拉远镜头生成完整人体。"
				)
			if base_prompt:
				identity_prompt = f"{identity_prompt}\n{base_prompt}"
			output_labels = requested_labels or ["侧面", "背面"]
			action_source_labels = prompt_labels if len(prompt_labels) == len(output_labels) else output_labels
			def clean_multiview_prompt_label(value: str) -> str:
				return re.sub(r"(?i)<\s*sks\s*>", "", str(value or "")).strip()
			action_prompts = "\n".join([
				clean_multiview_prompt_label(label) if str(label).strip().lower().startswith("<sks>") else multiview_prompt_for_label(label)
				for label in action_source_labels
			])
			lora_models = _safe_filename_list("loras") or []
			character_settings = _gjj_section_settings("character_library")
			sampling_steps = int(character_settings.get("sampling_steps", 0) or 0)
			sampling_cfg = float(character_settings.get("sampling_cfg", -1.0))
			sampling_sampler = str(character_settings.get("sampling_sampler") or "自动")
			sampling_scheduler = str(character_settings.get("sampling_scheduler") or "自动")
			sampling_denoise = float(character_settings.get("sampling_denoise", -1.0))
			sampling_seed = int(character_settings.get("sampling_seed", 0) or 0)
			keep_model = bool(character_settings.get("keep_model", True))
			def basename_seed(value: str) -> str:
				return str(value or "").replace("\\", "/").split("/")[-1].strip()
			def pick_model_any_subdir(folder_type: str, seed: str, available: list[str], fallback: str = "", extensions: tuple[str, ...] = ()) -> str:
				exts = tuple(ext.lower() for ext in extensions)
				resolved = gjjutils_resolve_model_by_extensionless_seed(seed, folder_type) if seed else ""
				if resolved and (not exts or str(resolved).replace("\\", "/").lower().endswith(exts)):
					return str(resolved)
				resolved = gjjutils_resolve_model_by_extensionless_seed(basename_seed(seed), folder_type) if seed else ""
				if resolved and (not exts or str(resolved).replace("\\", "/").lower().endswith(exts)):
					return str(resolved)
				picked = gjjutils_model_family_pick_model_name(seed, available, fallback, "basename") if seed else ""
				if picked and (not exts or str(picked).replace("\\", "/").lower().endswith(exts)):
					return picked
				picked = gjjutils_model_family_pick_model_name(basename_seed(seed), available, fallback, "basename") if seed else ""
				if picked and (not exts or str(picked).replace("\\", "/").lower().endswith(exts)):
					return picked
				return first_keyword_model(folder_type, basename_seed(seed) or seed, extensions)
			def pick_lora_any_subdir(seed: str, fallback: str = "") -> str:
				for candidate in (seed, basename_seed(seed), fallback, basename_seed(fallback)):
					resolved = gjjutils_resolve_model_by_extensionless_seed(candidate, "loras") if candidate else ""
					if resolved:
						return str(resolved)
					picked = gjjutils_model_family_pick_lora_name(candidate, lora_models, "", "basename") if candidate else ""
					if picked:
						return picked
				picked = first_keyword_model("loras", basename_seed(seed) or seed or fallback, (".safetensors",))
				return gjjutils_model_family_pick_lora_name(picked, lora_models, "", "basename") if picked else ""
			def first_keyword_model(folder_type: str, seed: str, extensions: tuple[str, ...]) -> str:
				keywords = [part for part in gjjutils_model_stem_without_quant(seed).split(" ") if part]
				matches = gjjutils_find_model_list(keywords, folder_type, "AND") if keywords else []
				exts = tuple(ext.lower() for ext in extensions)
				for match in matches:
					if str(match or "").replace("\\", "/").lower().endswith(exts):
						return str(match)
				return ""
			available_unets = _safe_filename_list("diffusion_models") or []
			available_clips = _safe_filename_list("text_encoders") or []
			available_vaes = _safe_filename_list("vae") or []
			unet_seed = str(character_settings.get("multiview_unet") or default_widget_value("unet_name", DEFAULT_QWEN2511_UNET))
			unet_name = pick_model_any_subdir("diffusion_models", unet_seed, available_unets, DEFAULT_QWEN2511_UNET, (".safetensors", ".gguf"))
			if not unet_name:
				for candidate in available_unets:
					if str(candidate or "").replace("\\", "/").split("/")[-1].lower() == "qwen_image_edit_2511_int8_convrot.safetensors":
						unet_name = str(candidate)
						break
			if multiview_unet_override:
				unet_name = pick_model_any_subdir("diffusion_models", multiview_unet_override, available_unets, unet_name, (".safetensors", ".gguf")) or unet_name
			if not _is_qwen2511_unet_name(unet_name):
				unet_name = _pick_qwen2511_unet_name(available_unets) or unet_name
			clip_seed = str(character_settings.get("multiview_clip") or "qwen_2.5_vl_7b_int4_convrot.safetensors")
			vae_seed = str(character_settings.get("multiview_vae") or "qwen_image_vae.safetensors")
			multiview_clip_override = pick_model_any_subdir(
				"text_encoders",
				multiview_clip_override or clip_seed,
				available_clips,
				clip_seed,
				(".safetensors", ".gguf"),
			)
			multiview_vae_override = pick_model_any_subdir(
				"vae",
				multiview_vae_override or vae_seed,
				available_vaes,
				vae_seed,
				(".safetensors", ".pt", ".pth"),
			)
			preset = gjjutils_match_model_family_preset(unet_name) or {}
			has_preset = bool(preset)
			lora_1_seed = str(preset.get("lora_1_name") if has_preset else (character_settings.get("multiview_lora_1") or DEFAULT_QWEN2511_LIGHTNING_LORA))
			lora_2_seed = str(character_settings.get("multiview_lora_2") or DEFAULT_MULTI_ANGLES_LORA)
			lora_1_name = pick_lora_any_subdir(lora_1_seed) if lora_1_seed else ""
			lora_2_name = pick_lora_any_subdir(lora_2_seed) if lora_2_seed else ""
			if multiview_lora_1_override and multiview_lora_1_override != "不使用":
				lora_1_name = pick_lora_any_subdir(multiview_lora_1_override, lora_1_name) or lora_1_name
			if multiview_lora_2_override and multiview_lora_2_override != "不使用":
				lora_2_name = pick_lora_any_subdir(multiview_lora_2_override, lora_2_name) or lora_2_name
			lora_3_name = ""
			if multiview_lora_3_override and multiview_lora_3_override != "不使用":
				lora_3_name = pick_lora_any_subdir(multiview_lora_3_override)
			lora_1_strength = float(preset.get("lora_1_strength", 1.0) or 1.0)
			lora_2_strength = float(preset.get("lora_2_strength", 1.0) or 1.0)
			missing_models = []
			if not unet_name:
				missing_models.append("主模型")
			if lora_1_seed and not lora_1_name:
				missing_models.append("Lightning LoRA")
			if lora_2_seed and not lora_2_name:
				missing_models.append("多角度 LoRA")
			if missing_models:
				raise RuntimeError(f"生成多视图缺少模型：{'、'.join(missing_models)}。请在 🧠 面板选择关键词匹配到的模型。")
			print(
				"[GJJ][CharacterLibrary][Multiview] resolved models:\n"
				f"  character_id: {character_id}\n"
				f"  labels: {output_labels}\n"
				f"  action_prompts:\n{action_prompts}\n"
				f"  UNET: {unet_name}\n"
				f"  CLIP override: {multiview_clip_override or '(auto qwen_2.5_vl)'}\n"
				f"  VAE override: {multiview_vae_override or '(auto qwen_image_vae)'}\n"
				f"  LoRA1: {lora_1_name} @ {lora_1_strength}\n"
				f"  LoRA2: {lora_2_name} @ {lora_2_strength}\n"
				f"  LoRA3: {lora_3_name or '(none)'}"
			)

			main_image = _pil_list_to_tensor([fit_character_reference_canvas(image, 1024, 1280)])
			action_kwargs = {}
			for index, action_image in enumerate(action_images[:len(output_labels)], start=1):
				action_kwargs[f"action_image_{index:02d}"] = _pil_list_to_tensor([
					fit_character_reference_canvas(action_image, 1024, 1280)
				])
			context_unique_id = "gjj_character_library_multiview"
			had_last_prompt_id = hasattr(server, "last_prompt_id")
			if not had_last_prompt_id:
				try:
					setattr(server, "last_prompt_id", context_unique_id)
				except Exception:
					pass
			try:
				multiview_result = GJJ_CharacterMultiViewStudio().generate(
					main_image=main_image,
					base_prompt=identity_prompt,
					negative_prompt=DEFAULT_NEGATIVE_PROMPT,
					action_prompts=action_prompts,
					unet_name=unet_name,
					lora_1_name=lora_1_name,
					lora_1_strength=lora_1_strength,
					lora_2_name=lora_2_name,
					lora_2_strength=lora_2_strength,
					lora_3_name=lora_3_name,
					lora_3_strength=1.0 if lora_3_name else 0.0,
					seed=seed if seed else sampling_seed,
					save_each_image=False,
					keep_model=keep_model,
					clip_name=multiview_clip_override if multiview_clip_override != "不使用" else "",
					vae_name=multiview_vae_override if multiview_vae_override != "不使用" else "",
					rmbg_model_name=rmbg_model_override if rmbg_model_override != "不使用" else "",
					sampling_steps=sampling_steps,
					sampling_cfg=sampling_cfg,
					sampling_sampler=sampling_sampler,
					sampling_scheduler=sampling_scheduler,
					sampling_denoise=sampling_denoise,
					prompt={},
					extra_pnginfo={},
					unique_id=context_unique_id,
					**action_kwargs,
				)
				if isinstance(multiview_result, dict):
					_collage, batch_images = multiview_result.get("result", (None, None))
				else:
					_collage, batch_images = multiview_result
			finally:
				if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
					try:
						delattr(server, "last_prompt_id")
					except Exception:
						pass

			generated = _tensor_to_pil_list(batch_images)
			if not generated:
				raise RuntimeError("多视图节点没有返回单图批量图片。")
			if split_generated_sheet:
				matted_sheets = comprehensive_matting_cutouts([generated[0]])
				sheet = matted_sheets[0] if matted_sheets else generated[0]
				split_views = split_transparent_character_sheet(sheet)
				if len(split_views) < 3:
					raise RuntimeError(f"三视图抠图后只分割出 {len(split_views)} 个主体，至少需要 3 个。")
				views = split_views[:3]
				labels = ["正面", "侧面", "背面"]
			else:
				views = comprehensive_matting_cutouts(generated)
				labels = output_labels if requested_labels else labels_for_multiview(len(views))
			for label, view in zip(labels, views):
				save_view_image(character_id, label, view)
			if preserved_headshot is not None:
				save_view_image(character_id, "大头照", preserved_headshot)
			return web.json_response({
				"ok": True,
				"count": len(views),
				"labels": labels,
				"character": enrich_manifest(read_manifest(character_id)),
			})
		except Exception as exc:
			print("[GJJ][CharacterLibrary][Multiview][ERROR]")
			print(traceback.format_exc())
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/annotate_missing")
	async def gjj_character_library_annotate_missing(request):
		try:
			try:
				data = await request.json()
			except Exception:
				data = {}
			limit = int(data.get("limit") or 9999)
			requested_ids = data.get("ids") if isinstance(data.get("ids"), list) else []
			requested_ids = [clean_key(item, "") for item in requested_ids]
			requested_ids = [item for item in requested_ids if item]
			character_settings = _gjj_section_settings("character_library")
			clip_name = str(data.get("clip_name") or character_settings.get("annotate_clip") or "qwen3.5_4b_fp8_mixed.safetensors")
			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor
				from .nodes.gjj_gemma_text_generate import (
					DEFAULT_CLIP_NAME,
					_generate_text,
					_load_merged_clip,
					_merged_generation_prompt,
				)
			except Exception as exc:
				raise RuntimeError(f"加载 GJJ_GemmaTextGenerate 运行时失败：{exc}") from exc

			model_name = clip_name or DEFAULT_CLIP_NAME
			clip = _load_merged_clip(model_name, "ideogram4", "default")
			processed = []
			skipped = []
			def name_has_gender_prefix(name: str) -> bool:
				return str(name or "").lstrip().startswith(("♀", "♂"))
			def strip_gender_prefix(name: str) -> str:
				return re.sub(r"^\s*(?:♀️|♂️|♀|♂)\s*", "", str(name or "")).strip()
			def parse_gender_and_note(text: str) -> tuple[str, str]:
				raw = str(text or "").strip()
				gender = ""
				note = raw
				match = re.search(r"性别\s*[:：]\s*(女|男|未知)", raw)
				if match:
					gender = match.group(1)
				match = re.search(r"备注\s*[:：]\s*(.+)", raw, flags=re.S)
				if match:
					note = match.group(1).strip()
				if not gender:
					if re.search(r"女性|女子|女孩|少女|女装|女士|她\b|女", raw):
						gender = "女"
					elif re.search(r"男性|男子|男孩|少年|男装|男士|他\b|男", raw):
						gender = "男"
				note = re.sub(r"^\s*性别\s*[:：]\s*(女|男|未知)\s*", "", note).strip()
				note = re.sub(r"^\s*备注\s*[:：]\s*", "", note).strip()
				return gender, note
			character_ids = requested_ids or [str(character.get("id") or "") for character in list_characters()]
			for character_id in character_ids:
				if len(processed) >= limit:
					break
				if not character_id:
					continue
				manifest = read_manifest(character_id)
				has_notes = bool(str(manifest.get("notes") or "").strip())
				has_gender_prefix = name_has_gender_prefix(manifest.get("name") or character_id)
				if has_notes and has_gender_prefix:
					skipped.append(character_id)
					continue
				images = []
				labels = []
				base = character_dir(character_id)
				views_for_inference = list(manifest.get("views") or [])
				head_views = [
					view for view in views_for_inference
					if any(token in str(view.get("label") or view.get("id") or "").lower() for token in ("大头", "头像", "头部", "脸", "face", "head", "portrait", "cover"))
				]
				views_for_inference = (head_views[:1] or views_for_inference[:1])
				for view in views_for_inference:
					file_name = str(view.get("file") or "")
					path = base / file_name
					if not path.is_file():
						continue
					try:
						img = Image.open(path).convert("RGBA")
						canvas = Image.new("RGB", img.size, (245, 245, 245))
						canvas.paste(img.convert("RGB"), mask=img.getchannel("A"))
						images.append(fit_rgb_canvas(canvas, 768))
						labels.append(str(view.get("label") or view.get("id") or "视图"))
					except Exception:
						continue
				if not images:
					skipped.append(character_id)
					continue
				system_prompt = (
					"你是人物资产库的中文标注助手。"
					"根据输入的人物大头照，反推出可见人物的性别表达，并生成一段简短、客观、可检索的人物备注。"
					"只描述可见外观，不编造姓名、剧情、性格或身份。"
					"必须只输出两行：第一行“性别：女/男/未知”，第二行“备注：60字以内中文备注”。"
				)
				user_prompt = (
					f"角色名：{strip_gender_prefix(manifest.get('name') or character_id)}\n"
					f"视图标签：{'、'.join(labels)}\n"
					"请根据头脸、体态、发型、服装等可见线索判断偏女性或偏男性；无法判断则写未知。"
				)
				tensor = _pil_list_to_tensor(images)
				context_unique_id = f"gjj_character_library_gemma_{character_id}"
				had_last_prompt_id = hasattr(server, "last_prompt_id")
				if not had_last_prompt_id:
					try:
						setattr(server, "last_prompt_id", context_unique_id)
					except Exception:
						pass
				try:
					text = _generate_text(
						clip,
						_merged_generation_prompt(system_prompt, user_prompt),
						180,
						"off",
						image=tensor,
						thinking=False,
						use_default_template=True,
						temperature=0.35,
						top_k=32,
						top_p=0.9,
						min_p=0.05,
						repetition_penalty=1.08,
						seed=0,
						presence_penalty=0.0,
					)
				finally:
					if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
						try:
							delattr(server, "last_prompt_id")
						except Exception:
							pass
				gender, note = parse_gender_and_note(text)
				note = re.sub(r"\s+", " ", str(note or "")).strip(" \n\r\t。")
				if len(note) > 120:
					note = note[:120].rstrip()
				if not note and not gender:
					skipped.append(character_id)
					continue
				if gender in {"女", "男"} and not has_gender_prefix:
					prefix = "♀️" if gender == "女" else "♂️"
					base_name = strip_gender_prefix(manifest.get("name") or character_id) or character_id
					manifest["name"] = f"{prefix}{base_name}"
				if note and not has_notes:
					manifest["notes"] = note
				write_manifest(manifest)
				processed.append({
					"id": character_id,
					"name": manifest.get("name") or character_id,
					"gender": gender,
					"notes": manifest.get("notes") or "",
				})
			return web.json_response({
				"ok": True,
				"model": model_name,
				"processed": processed,
				"processed_count": len(processed),
				"skipped_count": len(skipped),
				"characters": list_characters(),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.delete("/gjj/character_library/view")
	async def gjj_character_library_delete_view(request):
		try:
			character_id = request.query.get("id") or ""
			view_id = clean_key(request.query.get("view") or "", "")
			manifest = read_manifest(character_id)
			base = character_dir(character_id)
			next_views = []
			for item in manifest.get("views") or []:
				if item.get("id") == view_id:
					try:
						(base / item.get("file", "")).unlink(missing_ok=True)
					except Exception:
						pass
				else:
					next_views.append(item)
			manifest["views"] = next_views
			manifest = write_manifest(manifest)
			thumbnail_path(character_id).unlink(missing_ok=True)
			sync_character_thumbnail(manifest)
			return web.json_response({"ok": True, "character": enrich_manifest(manifest)})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/character_library/thumbnail/{file_name}")
	async def gjj_character_library_thumbnail(request):
		try:
			file_name = clean_key(request.match_info.get("file_name") or "", "")
			if not file_name.lower().endswith(".png"):
				raise ValueError("只能读取 PNG 缩略图。")
			character_id = clean_key(Path(file_name).stem, "")
			path = thumbnail_path(character_id)
			if not path.is_file():
				return web.Response(status=404, text="not found")
			return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.get("/gjj/character_library/file")
	async def gjj_character_library_file(request):
		try:
			character_id = request.query.get("id") or ""
			file_name = clean_key(request.query.get("file") or "", "")
			if not file_name.lower().endswith(".png"):
				raise ValueError("只能读取 PNG 视图。")
			base = character_dir(character_id).resolve()
			path = (base / file_name).resolve()
			if base not in path.parents or not path.is_file():
				return web.Response(status=404, text="not found")
			return web.FileResponse(path, headers={"Cache-Control": "no-store"})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.get("/gjj/character_library/voice_file")
	async def gjj_character_library_voice_file(request):
		try:
			path = voice_path_from_relative(request.query.get("path") or "")
			if not path.is_file():
				return web.Response(status=404, text="not found")
			return web.FileResponse(path, headers={"Cache-Control": "no-store", "Content-Type": "audio/mpeg"})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.get("/gjj/character_library/resolve")
	async def gjj_character_library_resolve(request):
		try:
			character = find_character(request.query.get("name") or request.query.get("id") or "")
			if not character:
				return web.json_response({"ok": False, "error": "未找到角色。"}, status=404)
			view_key = str(request.query.get("view") or "").strip()
			view = None
			for item in character.get("views") or []:
				if not view_key or view_key in {str(item.get("id") or ""), str(item.get("label") or "")}:
					view = item
					break
			return web.json_response({"ok": True, "character": character, "view": view})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/character_library/open_dir")
	async def gjj_character_library_open_dir(request):
		try:
			data = await request.json()
			character_id = str(data.get("id") or "").strip()
			directory = str(character_dir(character_id) if character_id else root_dir())
			if sys.platform.startswith("win"):
				flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
				subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", "/n,", directory], creationflags=flags)
			elif sys.platform == "darwin":
				subprocess.Popen(["open", directory])
			else:
				subprocess.Popen(["xdg-open", directory])
			return web.json_response({"ok": True, "directory": directory})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	server._gjj_character_library_api_registered = True
_register_gjj_character_library_api()

def _gjj_scene_library_directory():
	from pathlib import Path
	try:
		import folder_paths
		models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
	except Exception:
		models_dir = Path()
	if not str(models_dir):
		models_dir = _gjj_package_root().parent.parent / "models"
	return models_dir / "GJJ" / "scene_library"

def _gjj_legacy_scene_library_directory():
	return _gjj_package_root() / "presets" / "scene_library"

def _register_gjj_scene_library_api():
	try:
		import json
		import mimetypes
		import os
		import re
		import shutil
		import subprocess
		import sys
		import time
		import uuid
		from pathlib import Path
		from urllib.parse import urlencode
		from PIL import Image
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 场景库接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_scene_library_api_registered", False):
		return

	SAFE_TEXT_RE = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")
	SCENE_TYPES = {"360"}
	ASSET_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".hdr", ".exr"}
	PREVIEW_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

	def now_ms() -> int:
		return int(time.time() * 1000)

	def root_dir() -> Path:
		path = _gjj_scene_library_directory()
		path.mkdir(parents=True, exist_ok=True)
		legacy = _gjj_legacy_scene_library_directory()
		if legacy.exists() and legacy.is_dir():
			try:
				has_new_items = any(path.iterdir())
			except Exception:
				has_new_items = False
			if not has_new_items:
				for entry in legacy.iterdir():
					target = path / entry.name
					if target.exists():
						continue
					if entry.is_dir():
						shutil.move(str(entry), str(target))
					elif entry.is_file():
						shutil.move(str(entry), str(target))
		return path

	def clean_key(value: str, fallback: str = "item") -> str:
		text = SAFE_TEXT_RE.sub("_", str(value or "").strip()).strip("._- ")
		return (text or fallback)[:96]

	def clean_scene_type(value: str, fallback: str = "360") -> str:
		return "360"

	def split_keywords(value) -> list[str]:
		if isinstance(value, list):
			raw = value
		else:
			raw = re.split(r"[,，\n;；]+", str(value or ""))
		items = []
		for item in raw:
			text = str(item or "").strip()
			if text and text not in items:
				items.append(text[:48])
		return items[:80]

	def unique_scene_id(preferred: str, current_id: str = "") -> str:
		base_id = clean_key(preferred or current_id, "scene")
		current_id = clean_key(current_id, "")
		if current_id and base_id == current_id:
			return current_id
		if not (root_dir() / base_id).exists():
			return base_id
		for index in range(2, 1000):
			candidate = clean_key(f"{base_id}_{index}", "scene")
			if current_id and candidate == current_id:
				return current_id
			if not (root_dir() / candidate).exists():
				return candidate
		return clean_key(f"{base_id}_{uuid.uuid4().hex[:6]}", "scene")

	def scene_dir(scene_id: str) -> Path:
		scene_id = clean_key(scene_id, "")
		if not scene_id:
			raise ValueError("缺少场景 ID。")
		base = root_dir().resolve()
		path = (base / scene_id).resolve()
		if base not in path.parents and path != base:
			raise ValueError("场景路径不安全。")
		return path

	def manifest_path(scene_id: str) -> Path:
		return scene_dir(scene_id) / "manifest.json"

	def default_manifest(scene_id: str, name: str = "") -> dict:
		t = now_ms()
		return {
			"id": scene_id,
			"name": str(name or scene_id),
			"type": "360",
			"keywords": [],
			"notes": "",
			"created_at": t,
			"updated_at": t,
			"assets": [],
			"annotations": [],
		}

	def clean_asset_item(item: dict, created_at: int, updated_at: int) -> dict | None:
		file_name = clean_key(item.get("file") or "", "")
		ext = Path(file_name).suffix.lower()
		if ext not in ASSET_EXTS:
			return None
		asset_id = clean_key(item.get("id") or Path(file_name).stem, "asset")
		scene_type = clean_scene_type(item.get("type"), "hdr" if ext in {".hdr", ".exr"} else "360")
		return {
			"id": asset_id,
			"label": str(item.get("label") or asset_id),
			"type": scene_type,
			"file": file_name,
			"created_at": int(item.get("created_at") or created_at),
			"updated_at": int(item.get("updated_at") or updated_at),
		}

	def clean_annotation(item: dict) -> dict | None:
		keyword = str(item.get("keyword") or item.get("name") or "").strip()[:48]
		if not keyword:
			return None
		try:
			x = float(item.get("x"))
			y = float(item.get("y"))
		except Exception:
			return None
		x = min(1.0, max(0.0, x))
		y = min(1.0, max(0.0, y))
		return {
			"id": clean_key(item.get("id") or f"{keyword}_{int(x * 1000)}_{int(y * 1000)}", "mark"),
			"keyword": keyword,
			"x": x,
			"y": y,
			"asset_id": clean_key(item.get("asset_id") or "", ""),
			"notes": str(item.get("notes") or "")[:200],
			"created_at": int(item.get("created_at") or now_ms()),
		}

	def fit_scene_inference_canvas(image: Image.Image, width: int = 1344, height: int = 768) -> Image.Image:
		src = image.convert("RGB")
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		src.thumbnail((int(width), int(height)), resample)
		canvas = Image.new("RGB", (int(width), int(height)), (245, 245, 245))
		left = (canvas.width - src.width) // 2
		top = (canvas.height - src.height) // 2
		canvas.paste(src, (left, top))
		return canvas

	def parse_scene_coord_value(value):
		if value is None:
			return None
		if isinstance(value, (int, float)):
			return float(value)
		text = str(value or "").strip()
		if not text:
			return None
		text = text.replace("％", "%")
		match = re.search(r"-?\d+(?:\.\d+)?", text)
		if not match:
			return None
		return float(match.group(0))

	def scene_xy_from_item(item: dict):
		x_keys = ("x", "cx", "center_x", "centerX", "横坐标", "中心x", "中心X")
		y_keys = ("y", "cy", "center_y", "centerY", "纵坐标", "中心y", "中心Y")
		x = next((parse_scene_coord_value(item.get(key)) for key in x_keys if parse_scene_coord_value(item.get(key)) is not None), None)
		y = next((parse_scene_coord_value(item.get(key)) for key in y_keys if parse_scene_coord_value(item.get(key)) is not None), None)
		if x is not None and y is not None:
			return x, y
		for key in ("point", "position", "center", "coord", "coords", "coordinate", "coordinates", "中心点", "坐标", "位置"):
			value = item.get(key)
			if isinstance(value, dict):
				nested = scene_xy_from_item(value)
				if nested:
					return nested
			elif isinstance(value, (list, tuple)) and len(value) >= 2:
				x = parse_scene_coord_value(value[0])
				y = parse_scene_coord_value(value[1])
				if x is not None and y is not None:
					return x, y
			elif isinstance(value, str):
				values = re.findall(r"-?\d+(?:\.\d+)?", value.replace("％", "%"))
				if len(values) >= 2:
					return float(values[0]), float(values[1])
		for key in ("bbox", "box", "rect", "rectangle", "bounding_box", "框", "边框"):
			value = item.get(key)
			if isinstance(value, dict):
				x1 = parse_scene_coord_value(value.get("x1", value.get("left")))
				y1 = parse_scene_coord_value(value.get("y1", value.get("top")))
				x2 = parse_scene_coord_value(value.get("x2", value.get("right")))
				y2 = parse_scene_coord_value(value.get("y2", value.get("bottom")))
				w = parse_scene_coord_value(value.get("w", value.get("width")))
				h = parse_scene_coord_value(value.get("h", value.get("height")))
				if x1 is not None and y1 is not None and x2 is None and w is not None:
					x2 = x1 + w
				if x1 is not None and y1 is not None and y2 is None and h is not None:
					y2 = y1 + h
			elif isinstance(value, (list, tuple)) and len(value) >= 4:
				x1, y1, x2, y2 = [parse_scene_coord_value(v) for v in value[:4]]
			else:
				values = re.findall(r"-?\d+(?:\.\d+)?", str(value or ""))
				x1, y1, x2, y2 = [float(v) for v in values[:4]] if len(values) >= 4 else (None, None, None, None)
			if None not in (x1, y1, x2, y2):
				return (float(x1) + float(x2)) * 0.5, (float(y1) + float(y2)) * 0.5
		return None

	def parse_scene_annotations(text: str, asset_id: str = "") -> list[dict]:
		raw = str(text or "").strip()
		match = re.search(r"```(?:json)?\s*(.*?)```", raw, flags=re.S | re.I)
		if match:
			raw = match.group(1).strip()
		else:
			match = re.search(r"(\[[\s\S]*\]|\{[\s\S]*\})", raw)
			if match:
				raw = match.group(1).strip()
		try:
			parsed = json.loads(raw)
		except Exception:
			parsed = []
		if isinstance(parsed, dict):
			parsed = parsed.get("items") or parsed.get("annotations") or parsed.get("objects") or []
		if not isinstance(parsed, list):
			return []
		result = []
		seen = set()
		for item in parsed:
			if not isinstance(item, dict):
				continue
			keyword = str(item.get("keyword") or item.get("name") or item.get("label") or item.get("物品") or "").strip()[:48]
			if not keyword:
				continue
			xy = scene_xy_from_item(item)
			if not xy:
				continue
			x, y = xy
			if x > 1.0 or y > 1.0:
				x /= 100.0
				y /= 100.0
			x = min(1.0, max(0.0, x))
			y = min(1.0, max(0.0, y))
			key = keyword.lower()
			if key in seen:
				continue
			seen.add(key)
			clean = clean_annotation({
				"id": f"{keyword}_{int(x * 1000)}_{int(y * 1000)}",
				"keyword": keyword,
				"x": x,
				"y": y,
				"asset_id": asset_id,
				"notes": str(item.get("notes") or item.get("description") or item.get("备注") or "")[:200],
			})
			if clean:
				result.append(clean)
			if len(result) >= 16:
				break
		return result

	def parse_scene_ai_payload(text: str, asset_id: str = "") -> tuple[list[dict], list[str], str, str]:
		raw = str(text or "").strip()
		match = re.search(r"```(?:json)?\s*(.*?)```", raw, flags=re.S | re.I)
		if match:
			raw = match.group(1).strip()
		else:
			match = re.search(r"(\[[\s\S]*\]|\{[\s\S]*\})", raw)
			if match:
				raw = match.group(1).strip()
		try:
			parsed = json.loads(raw)
		except Exception:
			return parse_scene_annotations(text, asset_id), [], "", ""
		if isinstance(parsed, list):
			return parse_scene_annotations(raw, asset_id), [], "", ""
		if not isinstance(parsed, dict):
			return [], [], "", ""
		annotations_text = json.dumps(
			parsed.get("annotations") or parsed.get("items") or parsed.get("objects") or [],
			ensure_ascii=False,
		)
		keywords = split_keywords(parsed.get("keywords") or parsed.get("关键词") or [])
		notes = str(
			parsed.get("notes")
			or parsed.get("description")
			or parsed.get("summary")
			or parsed.get("备注")
			or parsed.get("场景备注")
			or ""
		).strip()[:300]
		suggested_name = str(
			parsed.get("name")
			or parsed.get("title")
			or parsed.get("scene_name")
			or parsed.get("场景名")
			or parsed.get("标题")
			or ""
		).strip()[:96]
		return parse_scene_annotations(annotations_text, asset_id), keywords, notes, suggested_name

	def fallback_scene_annotations(manifest: dict, asset_id: str = "") -> tuple[list[dict], list[str], str]:
		name = str(manifest.get("name") or manifest.get("id") or "场景").strip()
		lowered = name.lower()
		if any(word in name for word in ("大厅", "厅堂", "殿堂", "礼堂", "商店", "工厂", "建筑")):
			points = [
				("大厅中央" if "大厅" in name else "中央区域", 0.50, 0.55),
				("门", 0.56, 0.48),
				("窗户", 0.82, 0.43),
				("墙面", 0.46, 0.34),
				("地面", 0.50, 0.76),
				("天花板", 0.50, 0.18),
				("柱子", 0.22, 0.48),
				("装饰物", 0.66, 0.42),
			]
			keywords = split_keywords([name, "大厅", "门", "窗户", "墙面", "地面", "天花板", "柱子"])
			notes = f"{name}，自动生成基础空间标注；大模型未返回可解析坐标。"
		elif any(word in name for word in ("卧室", "房", "儿童房", "主卧")):
			points = [("床", 0.50, 0.62), ("窗户", 0.78, 0.42), ("门", 0.36, 0.50), ("墙面", 0.50, 0.34), ("地面", 0.50, 0.78), ("天花板", 0.50, 0.18)]
			keywords = split_keywords([name, "房间", "床", "窗户", "门", "墙面", "地面"])
			notes = f"{name}，自动生成基础房间标注；大模型未返回可解析坐标。"
		else:
			points = [("中央区域", 0.50, 0.55), ("左侧区域", 0.25, 0.50), ("右侧区域", 0.75, 0.50), ("背景墙", 0.50, 0.35), ("地面", 0.50, 0.78), ("天花板", 0.50, 0.18)]
			keywords = split_keywords([name, "场景", "中央区域", "背景墙", "地面", "天花板"])
			notes = f"{name}，自动生成基础场景标注；大模型未返回可解析坐标。"
		annotations = []
		for keyword, x, y in points:
			clean = clean_annotation({
				"id": f"{keyword}_{int(x * 1000)}_{int(y * 1000)}",
				"keyword": keyword,
				"x": x,
				"y": y,
				"asset_id": asset_id,
				"notes": "fallback",
			})
			if clean:
				annotations.append(clean)
		return annotations, keywords, notes

	def read_manifest(scene_id: str) -> dict:
		path = manifest_path(scene_id)
		if not path.is_file():
			return default_manifest(scene_id)
		try:
			data = json.loads(path.read_text(encoding="utf-8"))
		except Exception:
			data = {}
		if not isinstance(data, dict):
			data = {}
		data["id"] = str(scene_id)
		data["name"] = str(data.get("name") or scene_id)
		data["type"] = clean_scene_type(data.get("type"), "360")
		data["keywords"] = split_keywords(data.get("keywords") or "")
		data["notes"] = str(data.get("notes") or "")
		data["created_at"] = int(data.get("created_at") or now_ms())
		data["updated_at"] = int(data.get("updated_at") or data["created_at"])
		assets = []
		for item in data.get("assets") if isinstance(data.get("assets"), list) else []:
			if isinstance(item, dict):
				clean = clean_asset_item(item, data["created_at"], data["updated_at"])
				if clean:
					assets.append(clean)
		data["assets"] = assets
		annotations = []
		for item in data.get("annotations") if isinstance(data.get("annotations"), list) else []:
			if isinstance(item, dict):
				clean = clean_annotation(item)
				if clean:
					annotations.append(clean)
		data["annotations"] = annotations
		return data

	def write_manifest(data: dict) -> dict:
		scene_id = clean_key(data.get("id"), "")
		if not scene_id:
			raise ValueError("缺少场景 ID。")
		data["id"] = scene_id
		data["name"] = str(data.get("name") or scene_id).strip()[:96] or scene_id
		data["type"] = clean_scene_type(data.get("type"), "360")
		data["keywords"] = split_keywords(data.get("keywords") or "")
		data["notes"] = str(data.get("notes") or "")
		data["updated_at"] = now_ms()
		path = manifest_path(scene_id)
		path.parent.mkdir(parents=True, exist_ok=True)
		tmp = path.with_suffix(".json.tmp")
		tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
		os.replace(tmp, path)
		return read_manifest(scene_id)

	def file_url(scene_id: str, file_name: str, mtime: float = 0) -> str:
		return "/gjj/scene_library/file?" + urlencode({
			"id": scene_id,
			"file": file_name,
			"mtime": int(mtime or time.time()),
		})

	def read_radiance_rgbe(path: Path):
		import io
		import numpy as np
		with path.open("rb") as handle:
			stream = io.BytesIO(handle.read())
		width = height = 0
		x_sign = "+"
		y_sign = "-"
		while True:
			line = stream.readline()
			if not line:
				break
			text = line.decode("ascii", errors="ignore").strip()
			match = re.match(r"([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)", text)
			if match:
				y_sign, height_text, x_sign, width_text = match.groups()
				height = int(height_text)
				width = int(width_text)
				break
		if width <= 0 or height <= 0:
			raise RuntimeError("HDR 文件缺少 Radiance 分辨率行。")
		data = np.zeros((height, width, 4), dtype=np.uint8)
		for y in range(height):
			header = stream.read(4)
			if len(header) < 4:
				raise RuntimeError("HDR 像素数据不完整。")
			if width < 8 or width > 0x7FFF or header[0] != 2 or header[1] != 2 or ((header[2] << 8) | header[3]) != width:
				rest = stream.read(width * height * 4 - 4)
				raw = header + rest
				if len(raw) < width * height * 4:
					raise RuntimeError("HDR 非 RLE 像素数据不完整。")
				data = np.frombuffer(raw[: width * height * 4], dtype=np.uint8).reshape((height, width, 4)).copy()
				break
			scanline = np.zeros((4, width), dtype=np.uint8)
			for channel in range(4):
				x = 0
				while x < width:
					pair = stream.read(2)
					if len(pair) < 2:
						raise RuntimeError("HDR RLE 扫描线不完整。")
					count = pair[0]
					value = pair[1]
					if count > 128:
						run = count - 128
						scanline[channel, x : x + run] = value
						x += run
					else:
						run = count
						scanline[channel, x] = value
						if run > 1:
							values = stream.read(run - 1)
							if len(values) < run - 1:
								raise RuntimeError("HDR RLE literal 不完整。")
							scanline[channel, x + 1 : x + run] = np.frombuffer(values, dtype=np.uint8)
						x += run
			data[y] = scanline.T
		if y_sign == "+":
			data = data[::-1, :, :]
		if x_sign == "-":
			data = data[:, ::-1, :]
		exponent = data[..., 3].astype(np.int16)
		rgb = np.zeros((height, width, 3), dtype=np.float32)
		mask = exponent > 0
		if np.any(mask):
			scale = np.exp2(exponent[mask].astype(np.float32) - 136.0)
			rgb[mask] = data[..., :3][mask].astype(np.float32) * scale[:, None]
		return rgb

	def read_hdr_preview_array(path: Path):
		errors = []
		if path.suffix.lower() == ".hdr":
			try:
				return read_radiance_rgbe(path)
			except Exception as exc:
				errors.append(exc)
		try:
			import numpy as np
			image = Image.open(path)
			array = np.asarray(image)
			if array.size:
				return array
		except Exception as exc:
			errors.append(exc)
		try:
			import imageio.v3 as iio
			array = iio.imread(path)
			if getattr(array, "size", 0):
				return array
		except Exception as exc:
			errors.append(exc)
		try:
			import imageio
			array = imageio.imread(path)
			if getattr(array, "size", 0):
				return array
		except Exception as exc:
			errors.append(exc)
		try:
			os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
			import cv2
			array = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
			if array is not None and getattr(array, "size", 0):
				if len(array.shape) == 3 and array.shape[2] >= 3:
					array = cv2.cvtColor(array[:, :, :3], cv2.COLOR_BGR2RGB)
				return array
		except Exception as exc:
			errors.append(exc)
		if errors:
			raise errors[-1]
		raise ValueError("无法读取 HDR/EXR。")

	def write_hdr_placeholder_preview(path: Path, target: Path, message: str = "") -> bool:
		try:
			from PIL import ImageDraw, ImageFont
			target.parent.mkdir(parents=True, exist_ok=True)
			image = Image.new("RGB", (960, 540), (11, 18, 24))
			draw = ImageDraw.Draw(image)
			for y in range(image.height):
				t = y / max(1, image.height - 1)
				color = (
					int(16 + 28 * t),
					int(25 + 36 * t),
					int(34 + 48 * t),
				)
				draw.line([(0, y), (image.width, y)], fill=color)
			try:
				font_big = ImageFont.truetype("arial.ttf", 44)
				font = ImageFont.truetype("arial.ttf", 22)
				font_small = ImageFont.truetype("arial.ttf", 16)
			except Exception:
				font_big = ImageFont.load_default()
				font = ImageFont.load_default()
				font_small = ImageFont.load_default()
			draw.rounded_rectangle((40, 40, image.width - 40, image.height - 40), radius=18, outline=(78, 106, 118), width=2)
			draw.text((72, 78), "HDR / EXR", fill=(234, 245, 247), font=font_big)
			draw.text((72, 150), path.name[:80], fill=(184, 205, 212), font=font)
			draw.text((72, 206), "preview placeholder", fill=(121, 151, 162), font=font_small)
			if message:
				text = str(message).replace("\n", " ")[:150]
				draw.text((72, 242), text, fill=(121, 151, 162), font=font_small)
			image.save(target, "PNG")
			return True
		except Exception as exc:
			print(f"[GJJ] HDR 占位预览生成失败：{path.name}: {exc}")
			return False

	def hdr_array_to_display_image(array) -> Image.Image:
		import numpy as np
		array = np.asarray(array)
		if array.ndim == 2:
			array = np.stack([array, array, array], axis=-1)
		if array.ndim != 3:
			raise ValueError("HDR/EXR 图像维度无效。")
		if array.shape[2] > 3:
			array = array[:, :, :3]
		array = array.astype("float32")
		array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)
		array = np.maximum(array, 0.0)
		high = float(np.percentile(array, 99.7)) if array.size else 1.0
		if high <= 0:
			high = float(array.max()) if array.size else 1.0
		if high <= 0:
			high = 1.0
		array = np.clip(array / high, 0.0, 1.0)
		luma = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
		mid = float(np.percentile(luma, 55)) if luma.size else 0.3
		if mid > 0 and mid < 0.30:
			array = np.clip(array * min(3.2, 0.36 / mid), 0.0, 1.0)
		array = np.power(array, 1.0 / 2.2)
		luma2 = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
		mean = float(np.mean(luma2)) if luma2.size else 0.45
		if mean < 0.38:
			array = np.clip(array * min(1.8, 0.46 / max(0.01, mean)), 0.0, 1.0)
		out = (array * 255.0 + 0.5).astype("uint8")
		return Image.fromarray(out, "RGB")

	def tonemap_hdr_preview(path: Path, target: Path) -> bool:
		try:
			array = read_hdr_preview_array(path)
			image = hdr_array_to_display_image(array)
			resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
			image.thumbnail((1280, 720), resample)
			target.parent.mkdir(parents=True, exist_ok=True)
			image.save(target, "PNG")
			return True
		except Exception as exc:
			print(f"[GJJ] HDR 场景预览生成失败：{path.name}: {exc}")
			return write_hdr_placeholder_preview(path, target, str(exc))

	def ensure_scene_asset_preview(base: Path, path: Path) -> Path | None:
		ext = path.suffix.lower()
		if ext in PREVIEW_EXTS:
			return path
		if ext not in {".hdr", ".exr"}:
			return None
		preview = base / f"__preview_rgbe_{path.stem}.png"
		try:
			if preview.is_file() and preview.stat().st_size > 0 and preview.stat().st_mtime >= path.stat().st_mtime:
				return preview
		except Exception:
			pass
		return preview if tonemap_hdr_preview(path, preview) and preview.is_file() else None

	def scene_pil_from_hdr(path: Path) -> Image.Image:
		return hdr_array_to_display_image(read_hdr_preview_array(path))

	def is_360_ratio(image: Image.Image) -> bool:
		width, height = image.size
		if width <= 0 or height <= 0:
			return False
		return abs((width / height) - 2.0) <= 0.08

	def fit_to_360_png_canvas(image: Image.Image, width: int = 2048, height: int = 1024) -> Image.Image:
		src = image.convert("RGB")
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		if src.width != width or src.height != height:
			scale = max(width / max(1, src.width), height / max(1, src.height))
			next_size = (max(1, int(round(src.width * scale))), max(1, int(round(src.height * scale))))
			src = src.resize(next_size, resample)
			left = max(0, (src.width - width) // 2)
			top = max(0, (src.height - height) // 2)
			src = src.crop((left, top, left + width, top + height))
		return src

	def pil_to_scene_tensor(image: Image.Image):
		import numpy as np
		import torch
		array = np.asarray(image.convert("RGB")).astype("float32") / 255.0
		return torch.from_numpy(array).unsqueeze(0).contiguous()

	def generate_360_from_scene_image(image: Image.Image, scene_name: str, unique_id: str = "") -> Image.Image:
		try:
			from .nodes.gjj_360_panorama_generator import (
				DEFAULT_PROMPT_SUFFIX,
				DEFAULT_SEAM_PROMPT,
				GJJ_360PanoramaGenerator,
				_tensor_to_pil,
			)
		except Exception as exc:
			raise RuntimeError(f"加载 GJJ_360PanoramaGenerator 失败：{exc}") from exc

		def default_for(required: dict, key: str, fallback):
			spec = required.get(key)
			if isinstance(spec, tuple) and len(spec) > 1 and isinstance(spec[1], dict):
				value = spec[1].get("default")
				return fallback if value is None else value
			if isinstance(spec, tuple) and spec and isinstance(spec[0], list) and spec[0]:
				return spec[0][0]
			return fallback

		required = {}
		try:
			required = GJJ_360PanoramaGenerator.INPUT_TYPES().get("required") or {}
		except Exception:
			required = {}
		scene_settings = _gjj_section_settings("scene_library")

		def selected_model(key: str, setting_key: str, fallback: str) -> str:
			spec = required.get(key)
			options = list(spec[0]) if isinstance(spec, tuple) and spec and isinstance(spec[0], list) else []
			saved = str(scene_settings.get(setting_key) or "").replace("\\", "/").strip()
			if saved:
				saved_key = saved.lower()
				for option in options:
					option_key = str(option or "").replace("\\", "/").lower()
					if option_key == saved_key or option_key.endswith(f"/{saved_key}"):
						return str(option)
				family_tokens = [
					token for token in saved_key.rsplit("/", 1)[-1].split(".")[0].replace("-", "_").split("_")
					if token and token not in {"safetensors", "gguf", "convrot", "int4", "fp8", "mixed", "scaled"}
				]
				matches = [
					str(option) for option in options
					if all(token in str(option or "").replace("\\", "/").lower().replace("-", "_") for token in family_tokens)
				]
				if matches:
					return min(
						matches,
						key=lambda option: (
							0 if "int4_convrot" in option.lower().replace("-", "_") else
							1 if "int4" in option.lower() else 2,
							len(option),
							option.lower(),
						),
					)
			return str(default_for(required, key, fallback) or fallback)

		generator = GJJ_360PanoramaGenerator()
		context_unique_id = unique_id or f"gjj_scene_import_{uuid.uuid4().hex[:10]}"
		with _GJJTemporaryPromptId(server, context_unique_id):
			result = generator.generate(
				positive_prompt=f"Convert this scene image into a natural seamless 360-degree equirectangular panorama. Scene name: {scene_name}",
				negative_prompt="low quality, distorted, text, watermark",
				unet_name=selected_model("unet_name", "panorama_unet", "qwen_image_edit_2511_int4_convrot.safetensors"),
				unet_dtype=default_for(required, "unet_dtype", "default"),
				clip_name=selected_model("clip_name", "panorama_clip", "qwen_2.5_vl_7b_int4_convrot.safetensors"),
				vae_name=selected_model("vae_name", "panorama_vae", "qwen_image_vae.safetensors"),
				lora_1_name=default_for(required, "lora_1_name", ""),
				lora_1_strength=1.0,
				lora_2_name=default_for(required, "lora_2_name", ""),
				lora_2_strength=1.0,
				seed=0,
				steps=4,
				cfg=1.0,
				sampler_name=default_for(required, "sampler_name", "euler"),
				scheduler=default_for(required, "scheduler", "simple"),
				denoise=1.0,
				base_width=1024,
				base_height=512,
				final_width=1024,
				final_height=512,
				upscale_enabled=False,
				upscale_model_name=default_for(required, "upscale_model_name", ""),
				prompt_suffix=DEFAULT_PROMPT_SUFFIX,
				seam_prompt=DEFAULT_SEAM_PROMPT,
				seam_mask_width=256,
				seam_blur=24,
				repair_enabled=True,
				image=pil_to_scene_tensor(image),
				output_current_view=False,
				current_view_data="",
				save_directory="",
				unique_id=context_unique_id,
			)
		output = None
		if isinstance(result, dict):
			values = result.get("result") or []
			output = values[0] if values else None
		elif isinstance(result, (tuple, list)) and result:
			output = result[0]
		if output is None:
			raise RuntimeError("GJJ_360PanoramaGenerator 没有返回图像。")
		try:
			import torch
			from .nodes.gjj_seedvr2_image_upscaler import GJJ_SeedVR2ImageUpscaler
			seed_required = GJJ_SeedVR2ImageUpscaler.INPUT_TYPES().get("required") or {}

			def seed_default(key: str, fallback):
				spec = seed_required.get(key)
				if isinstance(spec, tuple) and len(spec) > 1 and isinstance(spec[1], dict):
					return spec[1].get("default", fallback)
				if isinstance(spec, tuple) and spec and isinstance(spec[0], list) and spec[0]:
					return spec[0][0]
				return fallback

			def seed_model(setting_key: str, input_key: str, fallback: str) -> str:
				spec = seed_required.get(input_key)
				options = list(spec[0]) if isinstance(spec, tuple) and spec and isinstance(spec[0], list) else []
				requested = str(scene_settings.get(setting_key) or fallback).replace("\\", "/").lower()
				for option in options:
					normalized = str(option or "").replace("\\", "/").lower()
					if normalized == requested or normalized.endswith(f"/{requested}"):
						return str(option)
				return str(seed_default(input_key, fallback) or fallback)

			seed_input = output.detach().clone().contiguous() if torch.is_tensor(output) else output
			with _GJJTemporaryPromptId(server, context_unique_id):
				with torch.inference_mode():
					output = GJJ_SeedVR2ImageUpscaler().upscale_image(
				common_video_height="手动输入",
				resolution=1024,
				max_resolution=2048,
				seed=0,
				dit_model=seed_model("seedvr2_dit", "dit_model", "seedvr2_3b_int8_convrot.safetensors"),
				vae_model=seed_model("seedvr2_vae", "vae_model", "ema_vae_fp16.safetensors"),
				device=seed_default("device", "cuda:0"),
				model_offload_device=seed_default("model_offload_device", "none"),
				tensor_offload_device=seed_default("tensor_offload_device", "cuda:0"),
				attention_mode=seed_default("attention_mode", "sdpa"),
				blocks_to_swap=seed_default("blocks_to_swap", 0),
				swap_io_components=seed_default("swap_io_components", False),
				encode_tiled=seed_default("encode_tiled", True),
				encode_tile_size=seed_default("encode_tile_size", 512),
				encode_tile_overlap=seed_default("encode_tile_overlap", 128),
				decode_tiled=seed_default("decode_tiled", True),
				decode_tile_size=seed_default("decode_tile_size", 512),
				decode_tile_overlap=seed_default("decode_tile_overlap", 128),
				tile_debug=seed_default("tile_debug", "false"),
				color_correction=seed_default("color_correction", "lab"),
				input_noise_scale=seed_default("input_noise_scale", 0.0),
				latent_noise_scale=seed_default("latent_noise_scale", 0.0),
				enable_debug=False,
				video_chunk_mode="关闭",
				frames_per_chunk=1,
				temporal_overlap=0,
				vae_temporal_size=seed_default("vae_temporal_size", 32),
				vae_temporal_overlap=seed_default("vae_temporal_overlap", 8),
				media=seed_input,
				unique_id=context_unique_id,
					)[0]
		except Exception as exc:
			raise RuntimeError(f"SeedVR2 全景放大失败：{exc}") from exc
		return fit_to_360_png_canvas(_tensor_to_pil(output), 2048, 1024)

	def save_360_png_asset(manifest: dict, image: Image.Image, label: str, method: str = "direct") -> dict:
		scene_id = clean_key(manifest.get("id") or "", "")
		if not scene_id:
			raise ValueError("缺少场景 ID。")
		base = scene_dir(scene_id)
		base.mkdir(parents=True, exist_ok=True)
		stem = clean_key(label or "scene", "scene")
		target_name = f"{stem}_360.png"
		if (base / target_name).exists():
			target_name = f"{stem}_360_{now_ms()}.png"
		final = fit_to_360_png_canvas(image, 2048, 1024)
		final.save(base / target_name, "PNG")
		timestamp = now_ms()
		asset = {
			"id": clean_key(Path(target_name).stem, "asset"),
			"label": label or Path(target_name).stem,
			"type": "360",
			"file": target_name,
			"created_at": timestamp,
			"updated_at": timestamp,
			"import_method": method,
		}
		manifest["type"] = "360"
		manifest["assets"] = [item for item in manifest.get("assets") or [] if item.get("id") != asset["id"]]
		manifest["assets"].append(asset)
		return asset

	def enrich_manifest(data: dict) -> dict:
		scene_id = data.get("id") or ""
		base = scene_dir(scene_id)
		enriched_assets = []
		for item in data.get("assets") or []:
			next_item = dict(item)
			path = base / item.get("file", "")
			try:
				stat = path.stat()
				next_item["size"] = stat.st_size
				next_item["url"] = file_url(scene_id, item.get("file", ""), stat.st_mtime)
				preview = ensure_scene_asset_preview(base, path)
				if preview:
					try:
						next_item["preview_url"] = file_url(scene_id, preview.name, preview.stat().st_mtime)
						next_item["preview_file"] = preview.name
					except Exception:
						pass
			except Exception:
				next_item["missing"] = True
			enriched_assets.append(next_item)
		data["assets"] = enriched_assets
		data["reference"] = f"@{data.get('name') or scene_id}"
		return data

	def list_scenes() -> list[dict]:
		items = []
		for entry in root_dir().iterdir():
			if entry.is_dir():
				try:
					items.append(enrich_manifest(read_manifest(entry.name)))
				except Exception:
					continue
		return items

	def scene_total_size(data: dict) -> int:
		base = scene_dir(data.get("id") or "")
		total = 0
		for item in data.get("assets") or []:
			try:
				total += (base / item.get("file", "")).stat().st_size
			except Exception:
				pass
		return total

	def sort_scenes(items: list[dict], sort_mode: str) -> list[dict]:
		def name_key(item):
			return str(item.get("name") or item.get("id") or "").lower()
		if sort_mode == "updated_asc":
			return sorted(items, key=lambda item: (int(item.get("updated_at") or 0), name_key(item)))
		if sort_mode == "name_asc":
			return sorted(items, key=name_key)
		if sort_mode == "name_desc":
			return sorted(items, key=name_key, reverse=True)
		if sort_mode == "size_desc":
			return sorted(items, key=lambda item: (-scene_total_size(item), name_key(item)))
		if sort_mode == "size_asc":
			return sorted(items, key=lambda item: (scene_total_size(item), name_key(item)))
		return sorted(items, key=lambda item: (-int(item.get("updated_at") or 0), name_key(item)))

	def list_scene_page(page: int = 1, page_size: int = 15, search: str = "", scene_type: str = "all", sort_mode: str = "updated_desc") -> dict:
		search_text = str(search or "").strip().lower()
		items = []
		for data in list_scenes():
			if scene_type in SCENE_TYPES and data.get("type") != scene_type:
				continue
			haystack = " ".join([
				str(data.get("id") or ""),
				str(data.get("name") or ""),
				str(data.get("notes") or ""),
				" ".join(data.get("keywords") or []),
				" ".join(str(mark.get("keyword") or "") for mark in data.get("annotations") or []),
			]).lower()
			if search_text and search_text not in haystack:
				continue
			items.append(data)
		items = sort_scenes(items, sort_mode)
		total = len(items)
		page_size = max(1, min(80, int(page_size or 15)))
		page_count = max(1, (total + page_size - 1) // page_size)
		page = max(1, min(int(page or 1), page_count))
		start = (page - 1) * page_size
		return {
			"ok": True,
			"scenes": items[start:start + page_size],
			"total": total,
			"page": page,
			"page_size": page_size,
			"page_count": page_count,
		}

	def find_scene(key: str) -> dict | None:
		text = str(key or "").strip()
		if not text:
			return None
		lowered = text.lower().lstrip("@")
		for item in list_scenes():
			if lowered in {str(item.get("id") or "").lower(), str(item.get("name") or "").lower()}:
				return item
		for item in list_scenes():
			keywords = [str(value or "").lower() for value in item.get("keywords") or []]
			marks = [str(value.get("keyword") or "").lower() for value in item.get("annotations") or []]
			if lowered in keywords or lowered in marks:
				return item
		return None

	@server.routes.get("/gjj/scene_library/list")
	async def gjj_scene_library_list(request):
		try:
			result = list_scene_page(
				page=int(request.query.get("page") or 1),
				page_size=int(request.query.get("page_size") or 15),
				search=request.query.get("search") or "",
				scene_type=request.query.get("type") or "all",
				sort_mode=request.query.get("sort") or "updated_desc",
			)
			return web.json_response(result)
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/scene_library/model_tree")
	async def gjj_scene_library_model_tree(_request):
		settings = _gjj_section_settings("scene_library")
		choices = _gjj_library_model_choices()
		try:
			from .nodes.gjj_seedvr2_image_upscaler import _get_seedvr2_model_options
			seedvr2_dit_choices, seedvr2_vae_choices = _get_seedvr2_model_options()
		except Exception:
			seedvr2_dit_choices = choices.get("seedvr2") or []
			seedvr2_vae_choices = choices.get("seedvr2") or []
		def model_item_path(item: dict) -> str:
			base = str(item.get("path") or "").replace("\\", "/").rstrip("/")
			filename = str(item.get("filename") or "").replace("\\", "/").strip("/")
			return f"{base}/{filename}" if filename else base
		try:
			from .nodes.gjj_360_panorama_generator import MODEL_TREE as PANORAMA_MODEL_TREE
		except Exception:
			PANORAMA_MODEL_TREE = []
		panorama_items = [
			{"label": str(item.get("label") or ""), "path": model_item_path(item)}
			for item in PANORAMA_MODEL_TREE
			if isinstance(item, dict) and "models" in model_item_path(item).replace("\\", "/").split("/")
		]
		return web.json_response({
			"ok": True,
			"title": "场景库依赖目录树",
			"settings_section": "scene_library",
			"settings": settings,
			"controls": [
				{"key": "panorama_unet", "label": "360 生成 UNET", "options": choices.get("diffusion_models") or []},
				{"key": "panorama_clip", "label": "360 生成 CLIP / VL", "options": choices.get("text_encoders") or []},
				{"key": "panorama_vae", "label": "360 生成 VAE", "options": choices.get("vae") or []},
				{"key": "annotate_clip", "label": "自动打标文本编码器", "options": choices.get("text_encoders") or []},
				{"key": "seedvr2_dit", "label": "SeedVR2 放大主模型", "options": seedvr2_dit_choices},
				{"key": "seedvr2_vae", "label": "SeedVR2 放大 VAE", "options": seedvr2_vae_choices},
			],
			"groups": [
				{
					"name": "🌏 360 场景生成",
					"items": [
						{"label": "UNET", "path": f"models/diffusion_models/{settings.get('panorama_unet') or 'qwen_image_edit_2511_int4_convrot.safetensors'}"},
						{"label": "CLIP / VL", "path": f"models/text_encoders/{settings.get('panorama_clip') or 'qwen_2.5_vl_7b_int4_convrot.safetensors'}"},
						{"label": "VAE", "path": f"models/vae/{settings.get('panorama_vae') or 'qwen_image_vae.safetensors'}"},
						*[
							item for item in panorama_items
							if not any(part in str(item.get("path") or "").replace("\\", "/").lower() for part in ("/diffusion_models/", "/text_encoders/", "/vae/"))
						],
					],
				},
				{
					"name": "🧠 自动打标",
					"items": [
						{"label": "Gemma / Qwen VL 文本编码器", "path": f"models/text_encoders/{settings.get('annotate_clip') or 'qwen3.5_4b_fp8_mixed.safetensors'}"},
					],
				},
				{
					"name": "🔍 SeedVR2 全景放大",
					"items": [
						{"label": "SeedVR2 主模型", "path": f"models/SEEDVR2/{settings.get('seedvr2_dit') or 'seedvr2_3b_int8_convrot.safetensors'}"},
						{"label": "SeedVR2 VAE", "path": f"models/SEEDVR2/{settings.get('seedvr2_vae') or 'ema_vae_fp16.safetensors'}"},
					],
				},
				{
					"name": "🗂 场景库存储",
					"items": [
						{"label": "场景库", "path": str(root_dir()), "folder": True},
					],
				},
			],
		})

	@server.routes.post("/gjj/scene_library/scene")
	async def gjj_scene_library_scene(request):
		try:
			data = await request.json()
			requested_id = clean_key(data.get("id") or "", "")
			name = str(data.get("name") or requested_id or "新场景").strip()[:96]
			scene_id = requested_id or unique_scene_id(name or uuid.uuid4().hex[:10])
			manifest = read_manifest(scene_id)
			manifest["name"] = name or manifest.get("name") or scene_id
			manifest["type"] = clean_scene_type(data.get("type") or manifest.get("type"), "360")
			manifest["keywords"] = split_keywords(data.get("keywords") if "keywords" in data else manifest.get("keywords"))
			manifest["notes"] = str(data.get("notes") if "notes" in data else manifest.get("notes") or "")
			if data.get("sync_id") and requested_id:
				next_id = unique_scene_id(name, requested_id)
				if next_id != requested_id:
					old_path = scene_dir(requested_id)
					new_path = scene_dir(next_id)
					if old_path.exists() and not new_path.exists():
						shutil.move(str(old_path), str(new_path))
					scene_id = next_id
					manifest["id"] = scene_id
			return web.json_response({"ok": True, "scene": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.delete("/gjj/scene_library/scene")
	async def gjj_scene_library_delete_scene(request):
		try:
			scene_id = request.query.get("id") or ""
			path = scene_dir(scene_id)
			if path.exists():
				shutil.rmtree(path)
			return web.json_response({"ok": True})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/scene_library/import_auto")
	async def gjj_scene_library_import_auto(request):
		try:
			reader = await request.multipart()
			fields = {}
			raw = b""
			file_name = ""
			async for part in reader:
				if part.name == "file":
					file_name = part.filename or "scene.png"
					raw = await part.read(decode=False)
				else:
					fields[part.name] = (await part.text()).strip()
			if not raw:
				raise ValueError("没有收到场景文件。")
			ext = Path(file_name).suffix.lower()
			if ext not in ASSET_EXTS:
				raise ValueError("只支持 png/jpg/webp/gif/bmp/hdr/exr 场景文件。")
			label = fields.get("label") or Path(file_name).stem or "场景"
			name = fields.get("name") or label or "新场景"
			import_unique_id = clean_key(fields.get("unique_id") or "", "")
			scene_id = clean_key(fields.get("id") or "", "") or unique_scene_id(name)
			manifest = read_manifest(scene_id)
			manifest["name"] = name or manifest.get("name") or scene_id
			manifest["type"] = "360"
			base = scene_dir(scene_id)
			base.mkdir(parents=True, exist_ok=True)
			method = "direct_360"
			if ext in {".hdr", ".exr"}:
				source_name = f"__import_source_{uuid.uuid4().hex[:10]}{ext}"
				source_path = base / source_name
				source_path.write_bytes(raw)
				try:
					image = scene_pil_from_hdr(source_path)
					method = "hdr_to_png"
				finally:
					try:
						source_path.unlink(missing_ok=True)
					except Exception:
						pass
			else:
				import io
				with Image.open(io.BytesIO(raw)) as opened:
					image = opened.convert("RGB")
				if is_360_ratio(image):
					method = "direct_360"
				else:
					method = "generated_360"
					image = generate_360_from_scene_image(image, name, import_unique_id)
			asset = save_360_png_asset(manifest, image, label, method)
			scene = enrich_manifest(write_manifest(manifest))
			return web.json_response({"ok": True, "scene": scene, "asset": asset, "method": method})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/scene_library/asset")
	async def gjj_scene_library_asset(request):
		try:
			reader = await request.multipart()
			fields = {}
			raw = b""
			file_name = ""
			async for part in reader:
				if part.name == "file":
					file_name = part.filename or "scene.png"
					raw = await part.read(decode=False)
				else:
					fields[part.name] = (await part.text()).strip()
			if not raw:
				raise ValueError("没有收到场景文件。")
			ext = Path(file_name).suffix.lower()
			if ext not in ASSET_EXTS:
				raise ValueError("只支持 png/jpg/webp/gif/bmp/hdr/exr 场景文件。")
			name = fields.get("name") or Path(file_name).stem or "新场景"
			scene_type = clean_scene_type(fields.get("type"), "hdr" if ext in {".hdr", ".exr"} else "360")
			scene_id = clean_key(fields.get("id") or "", "") or unique_scene_id(name)
			manifest = read_manifest(scene_id)
			manifest["name"] = fields.get("name") or manifest.get("name") or name
			manifest["type"] = scene_type
			base = scene_dir(scene_id)
			base.mkdir(parents=True, exist_ok=True)
			stem = clean_key(fields.get("label") or Path(file_name).stem or scene_type, "scene")
			target_name = f"{stem}{ext}"
			if (base / target_name).exists():
				target_name = f"{stem}_{now_ms()}{ext}"
			(base / target_name).write_bytes(raw)
			asset = {
				"id": clean_key(Path(target_name).stem, "asset"),
				"label": fields.get("label") or Path(file_name).stem or scene_type,
				"type": scene_type,
				"file": target_name,
				"created_at": now_ms(),
				"updated_at": now_ms(),
			}
			manifest["assets"] = [item for item in manifest.get("assets") or [] if item.get("id") != asset["id"]]
			manifest["assets"].append(asset)
			return web.json_response({"ok": True, "scene": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/scene_library/annotations")
	async def gjj_scene_library_annotations(request):
		try:
			data = await request.json()
			scene_id = clean_key(data.get("id") or "", "")
			manifest = read_manifest(scene_id)
			annotations = []
			for item in data.get("annotations") if isinstance(data.get("annotations"), list) else []:
				if isinstance(item, dict):
					clean = clean_annotation(item)
					if clean:
						annotations.append(clean)
			manifest["annotations"] = annotations
			return web.json_response({"ok": True, "scene": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/scene_library/annotate_missing")
	async def gjj_scene_library_annotate_missing(request):
		try:
			try:
				data = await request.json()
			except Exception:
				data = {}
			limit = int(data.get("limit") or 9999)
			requested_ids = data.get("ids") if isinstance(data.get("ids"), list) else []
			requested_ids = [clean_key(item, "") for item in requested_ids]
			requested_ids = [item for item in requested_ids if item]
			scene_settings = _gjj_section_settings("scene_library")
			clip_name = str(data.get("clip_name") or scene_settings.get("annotate_clip") or "qwen3.5_4b_fp8_mixed.safetensors")
			progress_id = clean_key(data.get("unique_id") or "", "")
			async def send_scene_progress(current: int, total: int, text: str) -> None:
				import asyncio
				if not progress_id:
					return
				try:
					server.send_sync("gjj_scene_library_progress", {
						"node": progress_id,
						"current": max(0, int(current)),
						"total": max(1, int(total or 1)),
						"text": str(text or ""),
					})
					await asyncio.sleep(0)
				except Exception:
					pass
			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor
				from .nodes.gjj_gemma_text_generate import (
					DEFAULT_CLIP_NAME,
					_generate_text,
					_load_merged_clip,
					_merged_generation_prompt,
				)
			except Exception as exc:
				raise RuntimeError(f"加载 GJJ_GemmaTextGenerate 运行时失败：{exc}") from exc

			model_name = clip_name or DEFAULT_CLIP_NAME
			clip = _load_merged_clip(model_name, "ideogram4", "default")
			processed = []
			skipped = []
			skipped_details = []
			scene_ids = requested_ids or [str(scene.get("id") or "") for scene in list_scenes()]
			total_count = max(1, len(scene_ids))
			await send_scene_progress(0, total_count, "正在准备自动打标...")
			for scene_index, scene_id in enumerate(scene_ids, start=1):
				if len(processed) >= limit:
					break
				if not scene_id:
					await send_scene_progress(scene_index, total_count, f"跳过空场景 {scene_index}/{total_count}")
					skipped_details.append({"id": "", "name": "", "reason": "场景 ID 为空"})
					continue
				manifest = read_manifest(scene_id)
				scene_label = str(manifest.get("name") or scene_id)
				await send_scene_progress(scene_index - 1, total_count, f"正在分析 {scene_index}/{total_count}：{scene_label}")
				has_annotations = bool(manifest.get("annotations"))
				has_keywords = bool(manifest.get("keywords"))
				has_notes = bool(str(manifest.get("notes") or "").strip())
				needs_rename = "_unsaved" in scene_label.lower()
				rename_only = needs_rename and has_annotations and has_keywords and has_notes
				if has_annotations and has_keywords and has_notes and not needs_rename:
					skipped.append(scene_id)
					skipped_details.append({"id": scene_id, "name": scene_label, "reason": "已有坐标、关键词和备注"})
					await send_scene_progress(scene_index, total_count, f"已跳过 {scene_index}/{total_count}：{scene_label}")
					continue
				asset = None
				for item in manifest.get("assets") or []:
					file_name = str(item.get("file") or "")
					if Path(file_name).suffix.lower() in PREVIEW_EXTS:
						asset = item
						break
				if not asset:
					skipped.append(scene_id)
					skipped_details.append({"id": scene_id, "name": scene_label, "reason": "没有可用于识别的 PNG/JPG 预览图"})
					await send_scene_progress(scene_index, total_count, f"无可用图片，跳过 {scene_index}/{total_count}：{scene_label}")
					continue
				path = scene_dir(scene_id) / str(asset.get("file") or "")
				if not path.is_file():
					skipped.append(scene_id)
					skipped_details.append({"id": scene_id, "name": scene_label, "reason": "图片文件缺失"})
					await send_scene_progress(scene_index, total_count, f"图片缺失，跳过 {scene_index}/{total_count}：{scene_label}")
					continue
				try:
					image = Image.open(path).convert("RGB")
				except Exception:
					skipped.append(scene_id)
					skipped_details.append({"id": scene_id, "name": scene_label, "reason": "图片读取失败"})
					await send_scene_progress(scene_index, total_count, f"图片读取失败，跳过 {scene_index}/{total_count}：{scene_label}")
					continue
				system_prompt = (
					"你是360场景资产库的中文物品坐标标注助手。"
					"根据输入的场景图片，识别清晰、可检索、适合后续关键词定位的主要物品或区域。"
					"坐标必须是原图上的归一化中心点，x/y 都在 0 到 1 之间；x 从左到右，y 从上到下。"
					"不要标注人物、光影、风格或抽象概念。不要输出解释。"
					"必须只输出 JSON 对象，格式为 {\"name\":\"简洁中文场景名\",\"keywords\":[\"卧室\",\"床\"],\"notes\":\"一句中文场景备注\",\"annotations\":[{\"keyword\":\"物品名\",\"x\":0.5,\"y\":0.5}]}。"
				)
				user_prompt = (
					f"场景名：{manifest.get('name') or scene_id}\n"
					f"场景类型：{manifest.get('type') or '360'}\n"
					"请标注 6 到 12 个最明显的物品或空间区域，例如：沙发、床、窗户、桌子、门、电视、地毯、柜子、阳台。"
					"同时给出 4 到 10 个检索关键词，并写一句简短场景备注，概括空间类型、氛围和主要物件。"
					"另给出一个 2 到 12 个汉字的简洁场景名，不要包含 Unsaved、文件扩展名、哈希或序号。"
					"如果图片是360等距全景图，坐标仍按整张展开图的位置返回。"
				)
				tensor = _pil_list_to_tensor([fit_scene_inference_canvas(image)])
				context_unique_id = f"gjj_scene_library_gemma_{scene_id}"
				had_last_prompt_id = hasattr(server, "last_prompt_id")
				if not had_last_prompt_id:
					try:
						setattr(server, "last_prompt_id", context_unique_id)
					except Exception:
						pass
				try:
					text = _generate_text(
						clip,
						_merged_generation_prompt(system_prompt, user_prompt),
						420,
						"off",
						image=tensor,
						thinking=False,
						use_default_template=True,
						temperature=0.25,
						top_k=32,
						top_p=0.9,
						min_p=0.05,
						repetition_penalty=1.05,
						seed=0,
						presence_penalty=0.0,
					)
				finally:
					if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
						try:
							delattr(server, "last_prompt_id")
						except Exception:
							pass
				asset_id = str(asset.get("id") or "")
				annotations, keywords, notes, suggested_name = parse_scene_ai_payload(text, asset_id)
				fallback_annotations, fallback_keywords, fallback_notes = fallback_scene_annotations(manifest, asset_id)
				if rename_only:
					annotations = manifest.get("annotations") or []
					keywords = manifest.get("keywords") or []
					notes = str(manifest.get("notes") or "")
				elif not annotations and has_annotations:
					annotations = manifest.get("annotations") or []
				if not annotations:
					await send_scene_progress(scene_index, total_count, f"模型未返回坐标，已生成基础标注 {scene_index}/{total_count}：{scene_label}")
					annotations = fallback_annotations
				if not keywords:
					keywords = fallback_keywords
				if not notes:
					notes = fallback_notes
				manifest["annotations"] = annotations
				if keywords and not manifest.get("keywords"):
					manifest["keywords"] = keywords
				if notes and not str(manifest.get("notes") or "").strip():
					manifest["notes"] = notes
				current_name = str(manifest.get("name") or scene_id).strip()
				if "_unsaved" in current_name.lower():
					replacement_name = re.sub(r"(?i)_?unsaved(?:[_\-\s].*)?$", "", suggested_name).strip(" _-.")
					if not replacement_name and keywords:
						replacement_name = str(keywords[0] or "").strip()
					if replacement_name:
						manifest["name"] = replacement_name[:96]
				write_manifest(manifest)
				processed.append({
					"id": scene_id,
					"name": manifest.get("name") or scene_id,
					"count": len(annotations),
					"annotations": annotations,
					"keywords": manifest.get("keywords") or [],
					"notes": manifest.get("notes") or "",
				})
				completed_label = str(manifest.get("name") or scene_label)
				rename_text = f"（原名：{scene_label}）" if completed_label != scene_label else ""
				await send_scene_progress(scene_index, total_count, f"已完成 {scene_index}/{total_count}：{completed_label}{rename_text}")
			await send_scene_progress(total_count, total_count, "自动打标完成")
			return web.json_response({
				"ok": True,
				"model": model_name,
				"processed": processed,
				"skipped": skipped_details,
				"processed_count": len(processed),
				"skipped_count": len(skipped),
				"scenes": list_scenes(),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/scene_library/file")
	async def gjj_scene_library_file(request):
		try:
			scene_id = request.query.get("id") or ""
			file_name = clean_key(request.query.get("file") or "", "")
			ext = Path(file_name).suffix.lower()
			if ext not in ASSET_EXTS:
				raise ValueError("场景文件类型无效。")
			base = scene_dir(scene_id).resolve()
			path = (base / file_name).resolve()
			if base not in path.parents or not path.is_file():
				return web.Response(status=404, text="not found")
			content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
			return web.FileResponse(path, headers={"Cache-Control": "no-store", "Content-Type": content_type})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.get("/gjj/scene_library/resolve")
	async def gjj_scene_library_resolve(request):
		try:
			scene = find_scene(request.query.get("name") or request.query.get("id") or request.query.get("keyword") or "")
			if not scene:
				return web.json_response({"ok": False, "error": "未找到场景。"}, status=404)
			keyword = str(request.query.get("keyword") or "").strip().lower()
			positions = []
			if keyword:
				for item in scene.get("annotations") or []:
					mark = str(item.get("keyword") or "").lower()
					if keyword == mark or keyword in mark or mark in keyword:
						positions.append(item)
			return web.json_response({"ok": True, "scene": scene, "positions": positions})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/scene_library/open_dir")
	async def gjj_scene_library_open_dir(request):
		try:
			data = await request.json()
			scene_id = str(data.get("id") or "").strip()
			directory = str(scene_dir(scene_id) if scene_id else root_dir())
			if sys.platform.startswith("win"):
				flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
				subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", "/n,", directory], creationflags=flags)
			elif sys.platform == "darwin":
				subprocess.Popen(["open", directory])
			else:
				subprocess.Popen(["xdg-open", directory])
			return web.json_response({"ok": True, "directory": directory})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	server._gjj_scene_library_api_registered = True
_register_gjj_scene_library_api()

def _gjj_costume_library_directory():
	from pathlib import Path
	try:
		import folder_paths
		models_dir = Path(getattr(folder_paths, "models_dir", "") or "")
	except Exception:
		models_dir = Path()
	if not str(models_dir):
		models_dir = _gjj_package_root().parent.parent / "models"
	return models_dir / "GJJ" / "costume_library"

def _gjj_legacy_costume_library_directory():
	return _gjj_package_root() / "presets" / "costume_library"

def _register_gjj_costume_library_api():
	try:
		import json
		import mimetypes
		import os
		import re
		import shutil
		import subprocess
		import sys
		import time
		import uuid
		from pathlib import Path
		from urllib.parse import urlencode
		from PIL import Image, ImageFilter
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 服化道接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_costume_library_api_registered", False):
		return

	SAFE_TEXT_RE = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")
	ASSET_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
	CATEGORIES = {"all", "clothing", "prop", "product"}
	CATEGORY_LABELS = {"all": "服化道", "clothing": "服装", "prop": "道具", "product": "产品"}
	CLOTHING_SAM3_PROMPT = (
		"armor, cuirass, pauldron, vambrace, gauntlet, greave, helmet, robe, gown, tunic, "
		"mantle, cloak, sash, collar, sleeve, hem, lining, uniform, outfit, attire, garment, "
		"costume, boot, war boot, belt, waistband, coat, jacket, blazer, shirt, sweater, "
		"pants, skirt, dress, hoodie"
	)
	CLOTHING_SAM3_CONFIDENCE = 0.5
	PRODUCT_MULTI_VIEW_LABELS = ["正面", "左侧", "背面", "右侧"]

	def now_ms() -> int:
		return int(time.time() * 1000)

	def root_dir() -> Path:
		path = _gjj_costume_library_directory()
		path.mkdir(parents=True, exist_ok=True)
		legacy = _gjj_legacy_costume_library_directory()
		if legacy.exists() and legacy.is_dir():
			try:
				has_new_items = any(path.iterdir())
			except Exception:
				has_new_items = False
			if not has_new_items:
				for entry in legacy.iterdir():
					target = path / entry.name
					if target.exists():
						continue
					if entry.is_dir():
						shutil.move(str(entry), str(target))
					elif entry.is_file():
						shutil.move(str(entry), str(target))
		return path

	def clean_key(value: str, fallback: str = "item") -> str:
		text = SAFE_TEXT_RE.sub("_", str(value or "").strip()).strip("._- ")
		return (text or fallback)[:96]

	def split_tags(value) -> list[str]:
		if isinstance(value, list):
			raw = value
		else:
			raw = re.split(r"[,，\n;；#]+", str(value or ""))
		items = []
		for item in raw:
			text = str(item or "").strip()
			if text and text not in items:
				items.append(text[:32])
		return items[:80]

	def clean_category(value: str) -> str:
		text = str(value or "").strip().lower()
		if text in {"prop", "道具", "props"}:
			return "prop"
		if text in {"product", "products", "产品", "商品"}:
			return "product"
		return "clothing"

	def clean_category_filter(value: str) -> str:
		text = str(value or "").strip().lower()
		if text in {"", "all", "全部"}:
			return "all"
		return clean_category(text)

	def category_label(value: str) -> str:
		return CATEGORY_LABELS.get(value, "服装")

	def unique_item_id(preferred: str, current_id: str = "") -> str:
		base_id = clean_key(preferred or current_id, "costume")
		current_id = clean_key(current_id, "")
		if current_id and base_id == current_id:
			return current_id
		if not (root_dir() / base_id).exists():
			return base_id
		for index in range(2, 1000):
			candidate = clean_key(f"{base_id}_{index}", "costume")
			if current_id and candidate == current_id:
				return current_id
			if not (root_dir() / candidate).exists():
				return candidate
		return clean_key(f"{base_id}_{uuid.uuid4().hex[:6]}", "costume")

	def unique_item_name(preferred: str, current_id: str = "") -> str:
		base_name = str(preferred or current_id or "服装").strip()[:80] or "服装"
		current_id = clean_key(current_id, "")
		used = set()
		for entry in root_dir().iterdir():
			if not entry.is_dir() or (current_id and entry.name == current_id):
				continue
			try:
				data = read_manifest(entry.name)
				name = str(data.get("name") or "").strip().lower()
				if name:
					used.add(name)
			except Exception:
				continue
		if base_name.lower() not in used:
			return base_name
		for index in range(2, 1000):
			candidate = f"{base_name}_{index}"
			if candidate.lower() not in used:
				return candidate[:96]
		return f"{base_name}_{uuid.uuid4().hex[:6]}"[:96]

	def item_dir(item_id: str) -> Path:
		item_id = clean_key(item_id, "")
		if not item_id:
			raise ValueError("缺少服化道 ID。")
		base = root_dir().resolve()
		path = (base / item_id).resolve()
		if base not in path.parents and path != base:
			raise ValueError("服化道路径不安全。")
		return path

	def manifest_path(item_id: str) -> Path:
		return item_dir(item_id) / "manifest.json"

	def default_manifest(item_id: str, name: str = "") -> dict:
		t = now_ms()
		return {
			"id": item_id,
			"name": str(name or item_id),
			"category": "clothing",
			"tags": [],
			"notes": "",
			"created_at": t,
			"updated_at": t,
			"assets": [],
		}

	def clean_asset_item(item: dict, created_at: int, updated_at: int) -> dict | None:
		file_name = clean_key(item.get("file") or "", "")
		if Path(file_name).suffix.lower() not in ASSET_EXTS:
			return None
		asset_id = clean_key(item.get("id") or Path(file_name).stem, "asset")
		clean = {
			"id": asset_id,
			"label": str(item.get("label") or asset_id),
			"file": file_name,
			"created_at": int(item.get("created_at") or created_at),
			"updated_at": int(item.get("updated_at") or updated_at),
		}
		for key in ("source_file", "sam3_prompt", "sam3_confidence", "sam3_status", "sam3_scores"):
			if key in item:
				clean[key] = item.get(key)
		return clean

	def read_manifest(item_id: str) -> dict:
		path = manifest_path(item_id)
		if not path.is_file():
			return default_manifest(item_id)
		try:
			data = json.loads(path.read_text(encoding="utf-8"))
		except Exception:
			data = {}
		if not isinstance(data, dict):
			data = {}
		data["id"] = str(item_id)
		data["name"] = str(data.get("name") or item_id)
		data["category"] = clean_category(data.get("category"))
		data["tags"] = split_tags(data.get("tags") or data.get("keywords") or "")
		data["notes"] = str(data.get("notes") or "")
		data["created_at"] = int(data.get("created_at") or now_ms())
		data["updated_at"] = int(data.get("updated_at") or data["created_at"])
		assets = []
		for item in data.get("assets") if isinstance(data.get("assets"), list) else []:
			if isinstance(item, dict):
				clean = clean_asset_item(item, data["created_at"], data["updated_at"])
				if clean:
					assets.append(clean)
		data["assets"] = assets
		return data

	def write_manifest(data: dict) -> dict:
		item_id = clean_key(data.get("id"), "")
		if not item_id:
			raise ValueError("缺少服化道 ID。")
		data["id"] = item_id
		data["name"] = str(data.get("name") or item_id).strip()[:96] or item_id
		data["category"] = clean_category(data.get("category"))
		data["tags"] = split_tags(data.get("tags") or "")
		data["notes"] = str(data.get("notes") or "")
		data["updated_at"] = now_ms()
		path = manifest_path(item_id)
		path.parent.mkdir(parents=True, exist_ok=True)
		tmp = path.with_suffix(".json.tmp")
		tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
		os.replace(str(tmp), str(path))
		return read_manifest(item_id)

	def file_url(item_id: str, file_name: str, mtime: float = 0) -> str:
		return "/gjj/costume_library/file?" + urlencode({
			"id": item_id,
			"file": file_name,
			"mtime": int(mtime or time.time()),
		})

	def costume_png_bytes(image: Image.Image) -> bytes:
		import io
		buffer = io.BytesIO()
		image.convert("RGBA").save(buffer, format="PNG")
		return buffer.getvalue()

	def costume_foreground_bbox(image: Image.Image, padding: int = 8) -> tuple[int, int, int, int] | None:
		alpha = image.convert("RGBA").getchannel("A")
		bbox = alpha.point(lambda value: 255 if value > 10 else 0).getbbox()
		if not bbox:
			return None
		left, top, right, bottom = bbox
		return (
			max(0, left - padding),
			max(0, top - padding),
			min(image.width, right + padding),
			min(image.height, bottom + padding),
		)

	def prepare_costume_matting_rgb_batch(images: list[Image.Image]) -> list[Image.Image]:
		if not images:
			return []
		sizes = [(image.width, image.height) for image in images]
		if len(set(sizes)) == 1:
			return [image.convert("RGB") for image in images]
		width = max(8, max(item[0] for item in sizes))
		height = max(8, max(item[1] for item in sizes))
		result = []
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		for image in images:
			src = image.convert("RGB")
			src.thumbnail((width, height), resample)
			canvas = Image.new("RGB", (width, height), (245, 245, 245))
			canvas.paste(src, ((width - src.width) // 2, (height - src.height) // 2))
			result.append(canvas)
		return result

	def costume_comprehensive_matting_cutouts(images: list[Image.Image]) -> list[Image.Image]:
		try:
			from .nodes.gjj_comprehensive_matting import (
				GJJ_ComprehensiveMatting,
				METHOD_RMBG14,
				_pil_list_to_tensor,
				_resolve_model_path,
				_tensor_to_pil_list,
			)
		except Exception as exc:
			raise RuntimeError(f"加载综合抠图运行时失败：{exc}") from exc
		settings = _gjj_section_settings("character_library")
		matting_method = str(settings.get("matting_method") or METHOD_RMBG14)
		if matting_method not in {METHOD_RMBG14}:
			matting_method = METHOD_RMBG14
		try:
			_resolve_model_path(matting_method, notify_missing=False)
		except Exception as exc:
			raise RuntimeError("未找到 RMBG1.4 抠图模型：models/RMBG/rmbg1.4.safetensors") from exc
		rgb_images = prepare_costume_matting_rgb_batch(images)
		context_unique_id = "gjj_costume_library_matting"
		had_last_prompt_id = hasattr(server, "last_prompt_id")
		if not had_last_prompt_id:
			try:
				setattr(server, "last_prompt_id", context_unique_id)
			except Exception:
				pass
		try:
			output = GJJ_ComprehensiveMatting().remove_background(
				matting_method=matting_method,
				background="透明",
				device="自动",
				process_res=1024,
				threshold=0.0,
				mask_blur=0.0,
				invert_output=False,
				inspyrenet_jit=False,
				media=_pil_list_to_tensor(rgb_images),
				prompt={},
				extra_pnginfo={},
				unique_id=context_unique_id,
			)
		finally:
			if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
				try:
					delattr(server, "last_prompt_id")
				except Exception:
					pass
		result = output.get("result") if isinstance(output, dict) else None
		if not result or len(result) < 1:
			raise RuntimeError("综合抠图没有返回图像结果。")
		rgba_images = [image.convert("RGBA") for image in _tensor_to_pil_list(result[0])]
		cutouts = []
		for rgba in rgba_images:
			box = costume_foreground_bbox(rgba, padding=8)
			cutouts.append(rgba.crop(box) if box else rgba)
		return cutouts

	def fit_costume_inference_canvas(image: Image.Image, max_side: int = 768) -> Image.Image:
		canvas = image.convert("RGB")
		canvas.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
		return canvas

	def extract_json_object(text: str) -> dict:
		try:
			data = json.loads(str(text or "").strip())
			return data if isinstance(data, dict) else {}
		except Exception:
			pass
		match = re.search(r"\{.*\}", str(text or ""), flags=re.DOTALL)
		if not match:
			return {}
		try:
			data = json.loads(match.group(0))
			return data if isinstance(data, dict) else {}
		except Exception:
			return {}

	def parse_costume_ai_payload(text: str, fallback_name: str = "") -> tuple[str, list[str], str]:
		data = extract_json_object(text)
		name = str(data.get("name") or data.get("名称") or fallback_name or "").strip()[:96]
		tags = split_tags(data.get("tags") or data.get("标签") or data.get("keywords") or data.get("关键词") or "")
		notes = str(data.get("notes") or data.get("备注") or data.get("description") or data.get("描述") or "").strip()[:300]
		return name, tags, notes

	def sam3_clothing_cutout(image: Image.Image) -> tuple[Image.Image, dict]:
		try:
			import gc
			import torch
			import comfy.model_management
			from .nodes.gjj_sam3_runtime import get_or_build_model, list_sam3_models, pick_available_name
		except Exception as exc:
			raise RuntimeError(f"加载 SAM3 运行时失败：{exc}") from exc
		available = list_sam3_models()
		sam3_model = pick_available_name("sam3.safetensors", available, "") or (available[0] if available else "")
		if not sam3_model:
			raise RuntimeError("未找到 SAM3 模型：请将 sam3.safetensors 放到 ComfyUI/models/sam3。")
		pil_image = image.convert("RGB")
		try:
			sam3 = get_or_build_model(sam3_model, precision="auto", compile_model=False)
			comfy.model_management.load_models_gpu([sam3])
			processor = sam3.processor
			if hasattr(processor, "sync_device_with_model"):
				processor.sync_device_with_model()
			processor.set_confidence_threshold(CLOTHING_SAM3_CONFIDENCE)
			state = processor.set_image(pil_image)
			state = processor.set_text_prompt(CLOTHING_SAM3_PROMPT, state)
			masks = state.get("masks", None)
			scores = state.get("scores", None)
			if masks is None or len(masks) == 0:
				return image.convert("RGBA"), {
					"sam3_prompt": CLOTHING_SAM3_PROMPT,
					"sam3_confidence": CLOTHING_SAM3_CONFIDENCE,
					"sam3_status": "no_detection",
					"sam3_scores": [],
				}
			if not isinstance(masks, torch.Tensor):
				masks = torch.as_tensor(masks)
			mask_tensor = masks.detach().float().cpu()
			if mask_tensor.ndim == 2:
				mask_tensor = mask_tensor.unsqueeze(0)
			combined = torch.any(mask_tensor > 0.5, dim=0).numpy().astype("uint8") * 255
			mask = Image.fromarray(combined, mode="L")
			alpha = mask.filter(ImageFilter.GaussianBlur(radius=0.6))
			rgba = image.convert("RGBA")
			rgba.putalpha(alpha)
			box = costume_foreground_bbox(rgba, padding=8)
			if box:
				rgba = rgba.crop(box)
			score_values = []
			if scores is not None:
				if not isinstance(scores, torch.Tensor):
					scores = torch.as_tensor(scores)
				score_values = [float(value) for value in scores.detach().float().cpu().flatten().tolist()]
			return rgba, {
				"sam3_prompt": CLOTHING_SAM3_PROMPT,
				"sam3_confidence": CLOTHING_SAM3_CONFIDENCE,
				"sam3_status": "cutout",
				"sam3_scores": score_values,
			}
		except Exception as exc:
			raise RuntimeError(f"SAM3 服装抠取失败：{exc}") from exc
		finally:
			try:
				del state
			except Exception:
				pass
			try:
				gc.collect()
				comfy.model_management.soft_empty_cache()
			except Exception:
				pass

	def sam3_model_hint_path() -> str:
		try:
			paths = folder_paths.get_folder_paths("sam3")
			if paths:
				return str(Path(paths[0]) / "sam3.safetensors")
		except Exception:
			pass
		return "models/sam3/sam3.safetensors"

	def fit_costume_reference_canvas(image: Image.Image, width: int = 1024, height: int = 1024) -> Image.Image:
		rgba = image.convert("RGBA")
		source = Image.new("RGB", rgba.size, (255, 255, 255))
		source.paste(rgba.convert("RGB"), mask=rgba.getchannel("A"))
		resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)
		source.thumbnail((int(width), int(height)), resample)
		canvas = Image.new("RGB", (int(width), int(height)), (255, 255, 255))
		canvas.paste(source, ((canvas.width - source.width) // 2, (canvas.height - source.height) // 2))
		return canvas

	def open_costume_asset_image(item_id: str, asset: dict) -> Image.Image:
		file_name = clean_key(asset.get("file") or "", "")
		if not file_name:
			raise ValueError("素材缺少文件。")
		path = (item_dir(item_id) / file_name).resolve()
		if item_dir(item_id).resolve() not in path.parents or not path.is_file():
			raise ValueError("素材文件不存在。")
		return Image.open(path).convert("RGBA")

	def product_multiview_prompt_for_label(label: str) -> str:
		text = str(label or "").strip()
		lowered = text.lower()
		view_rule = "标准正面视图，产品正对镜头"
		if "左侧" in text or "left" in lowered:
			view_rule = "左侧面视图，展示产品左侧轮廓和厚度"
		elif "右侧" in text or "right" in lowered:
			view_rule = "右侧面视图，展示产品右侧轮廓和厚度"
		elif "背" in text or "后" in text or "back" in lowered:
			view_rule = "背面/后视图，展示产品背部结构和背面标识"
		elif "45" in text or "斜" in text or "quarter" in lowered:
			view_rule = "45° 斜侧视图，展示产品正面和侧面结构"
		elif "顶部" in text or "俯" in text or "top" in lowered:
			view_rule = "顶部俯视视图，展示产品顶部结构"
		elif "底部" in text or "仰" in text or "bottom" in lowered:
			view_rule = "底部视图，展示产品底面结构"
		return f"白色背景，单个产品资产，{view_rule}，完整产品构图，居中摆放，保留原产品类别、轮廓、材质、颜色、品牌标识和关键结构，不添加人物、文字标签或装饰。"

	def save_costume_asset_image(item_id: str, label: str, image: Image.Image, source_file: str = "", extra: dict | None = None) -> dict:
		manifest = read_manifest(item_id)
		base = item_dir(item_id)
		base.mkdir(parents=True, exist_ok=True)
		asset_id = clean_key(label, "asset")
		file_name = f"{asset_id}.png"
		index = 2
		while (base / file_name).exists():
			file_name = f"{asset_id}_{index}.png"
			index += 1
		with (base / file_name).open("wb") as handle:
			handle.write(costume_png_bytes(image))
		t = now_ms()
		asset_info = {
			"id": clean_key(Path(file_name).stem, "asset"),
			"label": str(label or asset_id).strip()[:96] or asset_id,
			"file": file_name,
			"created_at": t,
			"updated_at": t,
		}
		if source_file:
			asset_info["source_file"] = clean_key(source_file, "")
		if extra:
			asset_info.update(extra)
		manifest.setdefault("assets", []).append(asset_info)
		return write_manifest(manifest)

	def enrich_manifest(data: dict) -> dict:
		item_id = data.get("id") or ""
		base = item_dir(item_id)
		assets = []
		for item in data.get("assets") or []:
			path = base / item.get("file", "")
			if not path.is_file():
				continue
			stat = path.stat()
			next_item = dict(item)
			next_item["size"] = stat.st_size
			next_item["url"] = file_url(item_id, item.get("file", ""), stat.st_mtime)
			assets.append(next_item)
		data = dict(data)
		data["assets"] = assets
		data["cover"] = assets[0]["url"] if assets else ""
		data["reference"] = f"@{data.get('name') or item_id}"
		return data

	def list_items() -> list[dict]:
		items = []
		for entry in root_dir().iterdir():
			if entry.is_dir():
				try:
					data = enrich_manifest(read_manifest(entry.name))
					if data.get("assets") or (entry / "manifest.json").is_file():
						items.append(data)
				except Exception:
					continue
		return items

	def item_total_size(data: dict) -> int:
		base = item_dir(data.get("id") or "")
		total = 0
		for item in data.get("assets") or []:
			try:
				total += (base / item.get("file", "")).stat().st_size
			except Exception:
				pass
		return total

	def sort_items(items: list[dict], sort_mode: str) -> list[dict]:
		def name_key(item):
			return str(item.get("name") or item.get("id") or "").lower()
		if sort_mode == "name_asc":
			return sorted(items, key=name_key)
		if sort_mode == "name_desc":
			return sorted(items, key=name_key, reverse=True)
		if sort_mode == "size_desc":
			return sorted(items, key=lambda item: (-item_total_size(item), name_key(item)))
		return sorted(items, key=lambda item: (-int(item.get("updated_at") or 0), name_key(item)))

	def normalize_search_text(value: str) -> str:
		return re.sub(r"\s+", " ", str(value or "").strip().lower())

	def parse_search_groups(value: str) -> list[list[str]]:
		text = normalize_search_text(value)
		if not text:
			return []
		groups = []
		for group in re.split(r"\s+", text):
			parts = [part.strip() for part in re.split(r"[|｜]+", group) if part.strip()]
			if parts:
				groups.append(parts)
		return groups

	def fuzzy_contains(haystack: str, needle: str) -> bool:
		if not needle:
			return True
		if needle in haystack:
			return True
		position = 0
		for char in needle:
			position = haystack.find(char, position)
			if position < 0:
				return False
			position += 1
		return True

	def matches_search(haystack: str, groups: list[list[str]]) -> bool:
		if not groups:
			return True
		return all(any(fuzzy_contains(haystack, part) for part in group) for group in groups)

	def list_item_page(page: int = 1, page_size: int = 15, search: str = "", category: str = "all", tag: str = "", sort_mode: str = "updated_desc") -> dict:
		search_groups = parse_search_groups(search)
		tag_text = str(tag or "").strip().lower()
		items = []
		all_tags = []
		for data in list_items():
			for item_tag in data.get("tags") or []:
				if item_tag not in all_tags:
					all_tags.append(item_tag)
			if category in CATEGORIES and category != "all" and data.get("category") != category:
				continue
			tags = [str(value or "").lower() for value in data.get("tags") or []]
			if tag_text and tag_text not in tags:
				continue
			haystack = " ".join([
				str(data.get("id") or ""),
				str(data.get("name") or ""),
				str(data.get("notes") or ""),
				" ".join(data.get("tags") or []),
				" ".join(str(asset.get("label") or "") for asset in data.get("assets") or []),
			]).lower()
			if not matches_search(haystack, search_groups):
				continue
			items.append(data)
		items = sort_items(items, sort_mode)
		all_tags = sorted(all_tags, key=lambda value: str(value).lower())
		total = len(items)
		page_size = max(1, min(80, int(page_size or 15)))
		page_count = max(1, (total + page_size - 1) // page_size)
		page = max(1, min(int(page or 1), page_count))
		start = (page - 1) * page_size
		return {
			"ok": True,
			"items": items[start:start + page_size],
			"tags": all_tags,
			"total": total,
			"page": page,
			"page_size": page_size,
			"page_count": page_count,
		}

	def find_item(key: str) -> dict | None:
		text = str(key or "").strip().lower().lstrip("@")
		if not text:
			return None
		for item in list_items():
			if text in {str(item.get("id") or "").lower(), str(item.get("name") or "").lower()}:
				return item
		for item in list_items():
			if text in [str(value or "").lower() for value in item.get("tags") or []]:
				return item
		return None

	@server.routes.get("/gjj/costume_library/list")
	async def gjj_costume_library_list(request):
		try:
			return web.json_response(list_item_page(
				page=int(request.query.get("page") or 1),
				page_size=int(request.query.get("page_size") or 15),
				search=request.query.get("search") or "",
				category=clean_category_filter(request.query.get("category") or "all"),
				tag=request.query.get("tag") or "",
				sort_mode=request.query.get("sort") or "updated_desc",
			))
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/costume_library/model_tree")
	async def gjj_costume_library_model_tree(_request):
		settings = _gjj_section_settings("character_library")
		return web.json_response({
			"ok": True,
			"title": "服化道存储目录树",
			"groups": [
				{
					"name": "💼 服化道存储",
					"items": [
						{"label": "服化道", "path": str(root_dir()), "folder": True},
					],
				},
				{
					"name": "✂️ 抠背景",
					"items": [
						{"label": "产品抠图", "path": "models/RMBG/rmbg1.4.safetensors"},
						{"label": "SAM3", "path": sam3_model_hint_path()},
					],
				},
				{
					"name": "🚀 产品多视图",
					"items": [
						{"label": "UNET", "path": f"models/diffusion_models/{settings.get('multiview_unet') or 'qwen_image_edit_2511_int8_convrot.safetensors'}"},
						{"label": "CLIP / VL", "path": "models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"},
						{"label": "VAE", "path": "models/vae/qwen_image_vae.safetensors"},
						{"label": "Lightning LoRA", "path": f"models/loras/{settings.get('multiview_lora_1') or 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors'}"},
						{"label": "多角度 LoRA", "path": f"models/loras/{settings.get('multiview_lora_2') or 'qwen-image-edit-2511-multiple-angles-lora.safetensors'}"},
					],
				},
			],
		})

	@server.routes.post("/gjj/costume_library/item")
	async def gjj_costume_library_item(request):
		try:
			data = await request.json()
			requested_id = clean_key(data.get("id") or "", "")
			name = str(data.get("name") or requested_id or "新服化道").strip()[:96]
			item_id = requested_id or unique_item_id(name or uuid.uuid4().hex[:10])
			manifest = read_manifest(item_id)
			manifest["name"] = name or manifest.get("name") or item_id
			manifest["category"] = clean_category(data.get("category") or manifest.get("category"))
			manifest["tags"] = split_tags(data.get("tags") if "tags" in data else manifest.get("tags"))
			manifest["notes"] = str(data.get("notes") if "notes" in data else manifest.get("notes") or "")
			if data.get("sync_id") and requested_id:
				next_id = unique_item_id(name, requested_id)
				if next_id != requested_id:
					old_path = item_dir(requested_id)
					new_path = item_dir(next_id)
					if old_path.exists() and not new_path.exists():
						shutil.move(str(old_path), str(new_path))
					item_id = next_id
					manifest["id"] = item_id
			return web.json_response({"ok": True, "item": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.delete("/gjj/costume_library/item")
	async def gjj_costume_library_delete_item(request):
		try:
			item_id = request.query.get("id") or ""
			path = item_dir(item_id)
			if path.exists():
				shutil.rmtree(path)
			return web.json_response({"ok": True})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/costume_library/asset")
	async def gjj_costume_library_asset(request):
		try:
			reader = await request.multipart()
			fields = {}
			file_part = None
			while True:
				part = await reader.next()
				if part is None:
					break
				if part.filename:
					file_part = part
					break
				fields[part.name] = await part.text()
			if file_part is None:
				raise ValueError("缺少素材文件。")
			name = str(fields.get("name") or "").strip()[:96]
			item_id = clean_key(fields.get("id") or "", "")
			is_new_item = not bool(item_id)
			if not item_id:
				item_id = unique_item_id(name or Path(file_part.filename).stem or uuid.uuid4().hex[:10])
			manifest = read_manifest(item_id)
			if name:
				manifest["name"] = unique_item_name(name, item_id) if is_new_item else name
			manifest["category"] = clean_category(fields.get("category") or manifest.get("category"))
			if "tags" in fields:
				manifest["tags"] = split_tags(fields.get("tags"))
			if "notes" in fields:
				manifest["notes"] = str(fields.get("notes") or "")
			base = item_dir(item_id)
			base.mkdir(parents=True, exist_ok=True)
			original = clean_key(Path(file_part.filename or "asset.png").name, "asset.png")
			ext = Path(original).suffix.lower()
			if ext not in ASSET_EXTS:
				raise ValueError("仅支持 PNG/JPG/WEBP/GIF/BMP 素材。")
			stem = clean_key(Path(original).stem, "asset")
			item_category = clean_category(manifest.get("category"))
			is_clothing = item_category == "clothing"
			is_product = item_category == "product"
			file_ext = ".png" if is_clothing or is_product else ext
			file_name = f"{stem}{file_ext}"
			index = 2
			while (base / file_name).exists():
				file_name = f"{stem}_{index}{file_ext}"
				index += 1
			raw = bytearray()
			while True:
				chunk = await file_part.read_chunk()
				if not chunk:
					break
				raw.extend(chunk)
			if is_clothing:
				import io
				source_image = Image.open(io.BytesIO(bytes(raw))).convert("RGBA")
				output_image, sam3_meta = sam3_clothing_cutout(source_image)
				output_bytes = costume_png_bytes(output_image)
			elif is_product:
				import io
				source_image = Image.open(io.BytesIO(bytes(raw))).convert("RGBA")
				matted = costume_comprehensive_matting_cutouts([source_image])
				output_image = matted[0] if matted else source_image
				sam3_meta = {
					"sam3_status": "rmbg_cutout",
				}
				output_bytes = costume_png_bytes(output_image)
			else:
				sam3_meta = {}
				output_bytes = bytes(raw)
			with (base / file_name).open("wb") as handle:
				handle.write(output_bytes)
			t = now_ms()
			asset_info = {
				"id": clean_key(Path(file_name).stem, "asset"),
				"label": str(fields.get("label") or Path(original).stem or "素材")[:96],
				"file": file_name,
				"created_at": t,
				"updated_at": t,
			}
			if is_clothing:
				asset_info.update({
					"source_file": original,
					"sam3_prompt": sam3_meta.get("sam3_prompt", CLOTHING_SAM3_PROMPT),
					"sam3_confidence": sam3_meta.get("sam3_confidence", CLOTHING_SAM3_CONFIDENCE),
					"sam3_status": sam3_meta.get("sam3_status", "cutout"),
					"sam3_scores": sam3_meta.get("sam3_scores", []),
				})
			elif is_product:
				asset_info.update({
					"source_file": original,
					"sam3_status": sam3_meta.get("sam3_status", "rmbg_cutout"),
				})
			manifest.setdefault("assets", []).append(asset_info)
			return web.json_response({"ok": True, "item": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/costume_library/generate_multiview")
	async def gjj_costume_library_generate_multiview(request):
		try:
			data = await request.json()
			item_id = clean_key(data.get("id") or data.get("item_id") or "", "")
			asset_id = clean_key(data.get("asset") or data.get("asset_id") or "", "")
			requested_labels = [str(item or "").strip()[:80] for item in (data.get("labels") if isinstance(data.get("labels"), list) else PRODUCT_MULTI_VIEW_LABELS)]
			requested_labels = [item for item in requested_labels if item] or PRODUCT_MULTI_VIEW_LABELS
			base_prompt = str(data.get("base_prompt") or "").strip()
			seed = int(data.get("seed") or 0)
			manifest = read_manifest(item_id)
			if clean_category(manifest.get("category")) != "product":
				raise ValueError("只有产品条目可以生成产品多视图。")
			assets = manifest.get("assets") or []
			reference_asset = None
			for asset in assets:
				if asset_id and asset.get("id") == asset_id:
					reference_asset = asset
					break
			if reference_asset is None:
				reference_asset = next((asset for asset in assets if Path(str(asset.get("file") or "")).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}), None)
			if reference_asset is None:
				raise RuntimeError("缺少产品参考图：请先导入一张产品图片。")
			image = open_costume_asset_image(item_id, reference_asset)

			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor, _tensor_to_pil_list
				from .nodes.gjj_character_multiview_studio import (
					DEFAULT_MULTI_ANGLES_LORA,
					DEFAULT_NEGATIVE_PROMPT,
					DEFAULT_QWEN2511_LIGHTNING_LORA,
					DEFAULT_QWEN2511_UNET,
					GJJ_CharacterMultiViewStudio,
					_pick_available_lora_name,
					_safe_filename_list,
				)
				from .nodes.common_utils.model_manager import (
					gjjutils_find_model_list,
					gjjutils_model_stem_without_quant,
				)
			except Exception as exc:
				raise RuntimeError(f"加载 GJJ_CharacterMultiViewStudio 运行时失败：{exc}") from exc

			lora_models = _safe_filename_list("loras") or []
			settings = _gjj_section_settings("character_library")
			def first_keyword_model(folder_type: str, seed: str, extensions: tuple[str, ...]) -> str:
				keywords = [part for part in gjjutils_model_stem_without_quant(seed).split(" ") if part]
				matches = gjjutils_find_model_list(keywords, folder_type, "AND") if keywords else []
				exts = tuple(ext.lower() for ext in extensions)
				for match in matches:
					if str(match or "").replace("\\", "/").lower().endswith(exts):
						return str(match)
				return ""
			unet_name = first_keyword_model("diffusion_models", str(settings.get("multiview_unet") or "qwen image edit 2511"), (".safetensors", ".gguf"))
			lora_1_name = first_keyword_model("loras", str(settings.get("multiview_lora_1") or "qwen lightning"), (".safetensors",))
			lora_2_name = first_keyword_model("loras", str(settings.get("multiview_lora_2") or "multiple angles"), (".safetensors",))
			missing_models = []
			if not unet_name:
				missing_models.append("主模型")
			if not lora_1_name:
				missing_models.append("Lightning LoRA")
			if not lora_2_name:
				missing_models.append("多角度 LoRA")
			if missing_models:
				raise RuntimeError(f"生成多视图缺少模型：{'、'.join(missing_models)}。请在 🧠 面板选择关键词匹配到的模型。")

			identity_prompt = (
				"图一只作为产品类别、轮廓、材质、颜色、品牌标识、结构细节和比例参考；"
				"不要继承图一的裁切范围、白条、阴影、背景边缘或镜头距离。"
				"每个输出视图必须严格服从对应视角文本，生成单个完整产品资产，白色背景。"
			)
			if base_prompt:
				identity_prompt = f"{identity_prompt}\n{base_prompt}"
			action_prompts = "\n".join([product_multiview_prompt_for_label(label) for label in requested_labels])
			main_image = _pil_list_to_tensor([fit_costume_reference_canvas(image, 1024, 1024)])
			context_unique_id = "gjj_costume_library_product_multiview"
			had_last_prompt_id = hasattr(server, "last_prompt_id")
			if not had_last_prompt_id:
				try:
					setattr(server, "last_prompt_id", context_unique_id)
				except Exception:
					pass
			try:
				multiview_result = GJJ_CharacterMultiViewStudio().generate(
					main_image=main_image,
					base_prompt=identity_prompt,
					negative_prompt=DEFAULT_NEGATIVE_PROMPT,
					action_prompts=action_prompts,
					unet_name=unet_name,
					lora_1_name=lora_1_name,
					lora_1_strength=1.0,
					lora_2_name=lora_2_name,
					lora_2_strength=1.0,
					seed=seed,
					save_each_image=False,
					prompt={},
					extra_pnginfo={},
					unique_id=context_unique_id,
				)
				if isinstance(multiview_result, dict):
					_collage, batch_images = multiview_result.get("result", (None, None))
				else:
					_collage, batch_images = multiview_result
			finally:
				if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
					try:
						delattr(server, "last_prompt_id")
					except Exception:
						pass

			generated = _tensor_to_pil_list(batch_images)
			if not generated:
				raise RuntimeError("多视图节点没有返回单图批量图片。")
			views = costume_comprehensive_matting_cutouts(generated)
			for label, view in zip(requested_labels, views):
				save_costume_asset_image(item_id, label, view, str(reference_asset.get("file") or ""), {
					"sam3_status": "product_multiview_rmbg",
				})
			return web.json_response({
				"ok": True,
				"count": len(views),
				"labels": requested_labels[:len(views)],
				"item": enrich_manifest(read_manifest(item_id)),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/costume_library/annotate_missing")
	async def gjj_costume_library_annotate_missing(request):
		try:
			try:
				data = await request.json()
			except Exception:
				data = {}
			limit = int(data.get("limit") or 9999)
			requested_ids = data.get("ids") if isinstance(data.get("ids"), list) else []
			requested_ids = [clean_key(item, "") for item in requested_ids]
			requested_ids = [item for item in requested_ids if item]
			requested_category = clean_category_filter(data.get("category") or "all")
			clip_name = str(data.get("clip_name") or "qwen3.5_4b_fp8_mixed.safetensors")
			progress_id = clean_key(data.get("unique_id") or "", "")

			def send_costume_progress(current: int, total: int, text: str) -> None:
				if not progress_id:
					return
				try:
					server.send_sync("gjj_costume_library_progress", {
						"node": progress_id,
						"current": max(0, int(current)),
						"total": max(1, int(total or 1)),
						"text": str(text or ""),
					})
				except Exception:
					pass

			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor
				from .nodes.gjj_gemma_text_generate import (
					DEFAULT_CLIP_NAME,
					_generate_text,
					_load_merged_clip,
					_merged_generation_prompt,
				)
			except Exception as exc:
				raise RuntimeError(f"加载 GJJ_GemmaTextGenerate 运行时失败：{exc}") from exc

			model_name = clip_name or DEFAULT_CLIP_NAME
			clip = _load_merged_clip(model_name, "ideogram4", "default")
			processed = []
			skipped = []
			item_ids = requested_ids or [
				str(item.get("id") or "")
				for item in list_items()
				if requested_category == "all" or clean_category(item.get("category")) == requested_category
			]
			total_count = max(1, len(item_ids))
			scope_category = requested_category
			if requested_ids:
				item_categories = {clean_category(read_manifest(item_id).get("category")) for item_id in item_ids if item_id}
				if len(item_categories) == 1:
					scope_category = next(iter(item_categories))
			scope_label = category_label(scope_category)
			send_costume_progress(0, total_count, f"正在准备{scope_label}自动打标...")
			for item_index, item_id in enumerate(item_ids, start=1):
				if len(processed) >= limit:
					break
				if not item_id:
					continue
				manifest = read_manifest(item_id)
				label = str(manifest.get("name") or item_id)
				send_costume_progress(item_index - 1, total_count, f"正在分析 {item_index}/{total_count}：{label}")
				item_category = clean_category(manifest.get("category"))
				if not requested_ids and requested_category != "all" and item_category != requested_category:
					skipped.append({"id": item_id, "name": label, "reason": f"不是{scope_label}"})
					continue
				if manifest.get("tags") and str(manifest.get("notes") or "").strip():
					skipped.append({"id": item_id, "name": label, "reason": "已有标签和备注"})
					send_costume_progress(item_index, total_count, f"已跳过 {item_index}/{total_count}：{label}")
					continue
				asset = None
				for item in manifest.get("assets") or []:
					file_name = str(item.get("file") or "")
					if Path(file_name).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
						asset = item
						break
				if not asset:
					skipped.append({"id": item_id, "name": label, "reason": "没有可识别图片"})
					continue
				path = item_dir(item_id) / str(asset.get("file") or "")
				if not path.is_file():
					skipped.append({"id": item_id, "name": label, "reason": "图片文件缺失"})
					continue
				try:
					image = Image.open(path).convert("RGB")
				except Exception:
					skipped.append({"id": item_id, "name": label, "reason": "图片读取失败"})
					continue
				if item_category == "prop":
					system_prompt = (
						"你是道具资产库的中文自动打标助手。"
						"根据输入的道具图片，识别物品类型、材质、颜色、风格、用途、时代和显著部件。"
						"不要把武器、器物、工具、饰品、家具、摆件识别成服装；不要翻译成英文，不要输出解释。"
						"必须只输出 JSON 对象，格式为 {\"name\":\"唯一、简短、可检索的中文道具名\",\"tags\":[\"长柄武器\",\"青蓝色\",\"金属\"],\"notes\":\"一句中文备注\"}。"
					)
					user_prompt = (
						f"当前文件名/名称：{manifest.get('name') or item_id}\n"
						"请给出一个不笼统的道具名，避免只写“道具”“物品”“新道具”。"
						"标签 4 到 10 个，优先包含：道具类型、主色、材质、用途、风格、关键部件。"
					)
					generic_names = {"道具", "物品", "新道具", "素材", "器物"}
				elif item_category == "product":
					system_prompt = (
						"你是产品资产库的中文自动打标助手。"
						"根据输入的产品图片，识别产品类型、外观造型、主色、材质、功能、使用场景、品牌感和显著部件。"
						"不要把产品图识别成服装或人物道具；不要翻译成英文，不要输出解释。"
						"必须只输出 JSON 对象，格式为 {\"name\":\"唯一、简短、可检索的中文产品名\",\"tags\":[\"清洁电器\",\"银白色\",\"塑料\"],\"notes\":\"一句中文备注\"}。"
					)
					user_prompt = (
						f"当前文件名/名称：{manifest.get('name') or item_id}\n"
						"请给出一个不笼统的产品名，避免只写“产品”“商品”“新产品”。"
						"标签 4 到 10 个，优先包含：产品类型、主色、材质、功能、风格、关键部件、使用场景。"
					)
					generic_names = {"产品", "商品", "新产品", "素材", "物品"}
				else:
					system_prompt = (
						"你是服装资产库的中文自动打标助手。"
						"根据输入的服装图片，识别服装类型、材质、颜色、风格、时代、用途和显著部件。"
						"不要翻译成英文，不要输出解释。"
						"必须只输出 JSON 对象，格式为 {\"name\":\"唯一、简短、可检索的中文服装名\",\"tags\":[\"盔甲\",\"金属\",\"披风\"],\"notes\":\"一句中文备注\"}。"
					)
					user_prompt = (
						f"当前文件名/名称：{manifest.get('name') or item_id}\n"
						"请给出一个不笼统的服装名，避免只写“服装”“衣服”“新服装”。"
						"标签 4 到 10 个，优先包含：服装类型、主色、材质、风格、用途、关键部件。"
					)
					generic_names = {"服装", "衣服", "新服装"}
				tensor = _pil_list_to_tensor([fit_costume_inference_canvas(image)])
				context_unique_id = f"gjj_costume_library_gemma_{item_id}"
				had_last_prompt_id = hasattr(server, "last_prompt_id")
				if not had_last_prompt_id:
					try:
						setattr(server, "last_prompt_id", context_unique_id)
					except Exception:
						pass
				try:
					text = _generate_text(
						clip,
						_merged_generation_prompt(system_prompt, user_prompt),
						260,
						"off",
						image=tensor,
						thinking=False,
						use_default_template=True,
						temperature=0.25,
						top_k=32,
						top_p=0.9,
						min_p=0.05,
						repetition_penalty=1.05,
						seed=0,
						presence_penalty=0.0,
					)
				finally:
					if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
						try:
							delattr(server, "last_prompt_id")
						except Exception:
							pass
				ai_name, tags, notes = parse_costume_ai_payload(text, label)
				if ai_name and ai_name not in generic_names:
					manifest["name"] = unique_item_name(ai_name, item_id)
				if tags and not manifest.get("tags"):
					manifest["tags"] = tags
				if notes and not str(manifest.get("notes") or "").strip():
					manifest["notes"] = notes
				write_manifest(manifest)
				processed.append({
					"id": item_id,
					"name": manifest.get("name") or item_id,
					"category": item_category,
					"tags": manifest.get("tags") or [],
					"notes": manifest.get("notes") or "",
				})
				send_costume_progress(item_index, total_count, f"已完成 {item_index}/{total_count}：{manifest.get('name') or item_id}")
			send_costume_progress(total_count, total_count, f"{scope_label}自动打标完成")
			return web.json_response({
				"ok": True,
				"model": model_name,
				"scope_label": scope_label,
				"processed": processed,
				"skipped": skipped,
				"processed_count": len(processed),
				"skipped_count": len(skipped),
				"items": list_items(),
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.get("/gjj/costume_library/file")
	async def gjj_costume_library_file(request):
		try:
			item_id = request.query.get("id") or ""
			file_name = clean_key(request.query.get("file") or "", "")
			if Path(file_name).suffix.lower() not in ASSET_EXTS:
				raise ValueError("素材文件类型无效。")
			base = item_dir(item_id).resolve()
			path = (base / file_name).resolve()
			if base not in path.parents or not path.is_file():
				return web.Response(status=404, text="not found")
			content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
			return web.FileResponse(path, headers={"Cache-Control": "no-store", "Content-Type": content_type})
		except Exception as exc:
			return web.Response(status=400, text=str(exc))

	@server.routes.get("/gjj/costume_library/resolve")
	async def gjj_costume_library_resolve(request):
		try:
			item = find_item(request.query.get("name") or request.query.get("id") or request.query.get("tag") or "")
			if not item:
				return web.json_response({"ok": False, "error": "未找到服化道。"}, status=404)
			return web.json_response({"ok": True, "item": item})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	@server.routes.post("/gjj/costume_library/open_dir")
	async def gjj_costume_library_open_dir(request):
		try:
			data = await request.json()
			item_id = str(data.get("id") or "").strip()
			directory = str(item_dir(item_id) if item_id else root_dir())
			if sys.platform.startswith("win"):
				flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
				subprocess.Popen(["cmd.exe", "/c", "start", "", "/max", "explorer.exe", "/n,", directory], creationflags=flags)
			elif sys.platform == "darwin":
				subprocess.Popen(["open", directory])
			else:
				subprocess.Popen(["xdg-open", directory])
			return web.json_response({"ok": True, "directory": directory})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

	server._gjj_costume_library_api_registered = True
_register_gjj_costume_library_api()

def _register_gjj_summon_model_api():
	try:
		import os
		import re
		import folder_paths
		from aiohttp import web
		from server import PromptServer
	except Exception as exc:
		print(f"[GJJ] 召唤模型接口注册失败：{exc}")
		return

	server = getattr(PromptServer, "instance", None)
	if server is None or getattr(server, "_gjj_summon_model_api_registered", False):
		return

	KNOWN_MODEL_EXTENSIONS = {
		".safetensors", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".gguf",
		".sft", ".pkl", ".onnx", ".engine",
	}
	QUANT_PATTERN = re.compile(
		r"(?i)(^|[\s._\-/\\])("
		r"fp8(?:[\s._-]?e[45]m[23]fn?)?|fp16|fp32|bf16|float16|float32|"
		r"int8|int4|nf4|mxfp4|bnb4bit|bitsandbytes|"
		r"q[2-8](?:[\s._-]?[a-z0-9]+){0,3}|"
		r"e4m3fn|e5m2|gguf"
		r")(?=$|[\s._\-/\\])"
	)
	QUANT_MODIFIER_PATTERN = re.compile(
		r"(?i)(^|[\s._\-/\\])(?:input[\s._-]?)?scaled(?=$|[\s._\-/\\])"
	)
	RANK_TOKEN_PATTERN = re.compile(r"(?i)^(?:rank|dim|r)\d+$")
	NOTE_BLOCK_PATTERN = re.compile(
		r"(?:[\s._-]*(?:\([^)]*\)|\[[^\]]*\]|（[^）]*）|【[^】]*】))+$"
	)
	NOTE_TOKEN_PATTERN = re.compile(
		r"(?i)^(?:v(?:er(?:sion)?)?\d+(?:\.\d+)*|final\d*|最终版|修订版|备注.*)$"
	)
	CHINESE_PATTERN = re.compile(r"[\u4e00-\u9fff]")
	LOOSE_NOTE_SUFFIXES = {
		"kj", "kijai", "fix", "fixed", "patch", "patched",
		"convert", "converted", "comfy", "comfyui",
	}
	CATEGORY_ALIASES = {
		"checkpoint": ("checkpoints",),
		"ckpt": ("checkpoints",),
		"unet": ("diffusion_models",),
		"diffusion_model": ("diffusion_models",),
		"diffusion_models": ("diffusion_models",),
		"unet_gguf": ("unet_gguf",),
		"text_encoder": ("text_encoders", "clip"),
		"text_encoders": ("text_encoders", "clip"),
		"clip": ("text_encoders", "clip"),
		"clip_vision": ("clip_vision",),
		"vae": ("vae",),
		"vae_approx": ("vae_approx",),
		"lora": ("loras",),
		"loras": ("loras",),
		"controlnet": ("controlnet", "controlnets"),
		"controlnets": ("controlnet", "controlnets"),
		"upscale": ("upscale_models", "latent_upscale_models"),
		"upscale_model": ("upscale_models", "latent_upscale_models"),
		"upscale_models": ("upscale_models",),
		"latent_upscale_models": ("latent_upscale_models", "upscale_models"),
		"audio_encoder": ("audio_encoders", "wav2vec2"),
		"audio_encoders": ("audio_encoders", "wav2vec2"),
		"wav2vec": ("wav2vec2", "audio_encoders"),
		"wav2vec2": ("wav2vec2", "audio_encoders"),
		"detection": ("detection", "onnx", "ultralytics_bbox"),
		"onnx": ("onnx", "detection"),
		"yolo": ("ultralytics_bbox", "ultralytics_segm", "detection", "onnx"),
		"ultralytics": ("ultralytics_bbox", "ultralytics_segm"),
		"ultralytics_bbox": ("ultralytics_bbox", "detection", "onnx"),
		"ultralytics_segm": ("ultralytics_segm", "ultralytics_bbox", "detection", "onnx"),
		"bbox": ("ultralytics_bbox", "ultralytics_segm", "detection", "onnx"),
		"segm": ("ultralytics_segm", "ultralytics_bbox", "detection", "onnx"),
		"segment": ("ultralytics_segm", "ultralytics_bbox", "detection", "onnx"),
		"segmentation": ("ultralytics_segm", "ultralytics_bbox", "detection", "onnx"),
	}
	SKIP_FOLDERS = {"custom_nodes", "input", "output", "temp", "configs"}

	def strip_extension(text):
		value = str(text or "").strip().replace("\\", "/")
		lower = value.lower()
		for ext in sorted(KNOWN_MODEL_EXTENSIONS, key=len, reverse=True):
			if lower.endswith(ext):
				return value[:-len(ext)]
		root, ext = os.path.splitext(value)
		return root if ext and len(ext) <= 12 else value

	def clean_model_key(text, basename_only=True):
		value = str(text or "").strip().replace("\\", "/")
		if basename_only:
			value = value.rsplit("/", 1)[-1]
		value = strip_extension(value)
		value = QUANT_PATTERN.sub(" ", value)
		value = QUANT_MODIFIER_PATTERN.sub(" ", value)
		value = re.sub(r"(?i)\b(?:fp|bf|int)\s*(?:8|16|32)\b", " ", value)
		value = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", " ", value.lower())
		return re.sub(r"\s+", " ", value).strip()

	def compact_key(text, basename_only=True):
		return re.sub(r"\s+", "", clean_model_key(text, basename_only=basename_only))

	def token_signature(text):
		tokens = [token for token in clean_model_key(text, basename_only=True).split() if token]
		return tuple(sorted(tokens))

	def rank_variant_signature(text):
		tokens = [token for token in clean_model_key(text, basename_only=True).split() if token]
		result = []
		changed = False
		has_lora_marker = any(token in {"lora", "lycoris", "locon", "loha"} for token in tokens)
		index = 0
		while index < len(tokens):
			token = tokens[index]
			if RANK_TOKEN_PATTERN.fullmatch(token):
				result.append("rank")
				changed = True
			elif token in {"rank", "dim"} and index + 1 < len(tokens) and tokens[index + 1].isdigit():
				result.append("rank")
				changed = True
				index += 1
			else:
				result.append(token)
			index += 1
		return tuple(sorted(result)), changed, has_lora_marker

	def path_key(text):
		return str(text or "").strip().replace("\\", "/").lower()

	def basename_path_key(text):
		return path_key(text).rsplit("/", 1)[-1]

	def path_depth(text):
		value = path_key(text)
		return value.count("/") + value.count("\\")

	def model_extension(text):
		lower = str(text or "").strip().lower()
		for ext in sorted(KNOWN_MODEL_EXTENSIONS, key=len, reverse=True):
			if lower.endswith(ext):
				return ext
		return ""

	def note_base_keys(text):
		value = str(text or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
		value = strip_extension(value)
		result = set()
		without_block = NOTE_BLOCK_PATTERN.sub("", value).rstrip(" ._-")
		if without_block and without_block != value:
			result.add(compact_key(without_block))

		tokens = clean_model_key(value, basename_only=True).split()
		trimmed = list(tokens)
		while trimmed and NOTE_TOKEN_PATTERN.fullmatch(trimmed[-1]):
			trimmed.pop()
			if trimmed:
				result.add("".join(trimmed))

		for index, token in enumerate(tokens):
			if index > 0 and CHINESE_PATTERN.search(token):
				prefix = "".join(tokens[:index])
				if len(prefix) >= 8:
					result.add(prefix)
				break
		result.discard("")
		return result

	def score_candidate(query, filename):
		query_ext = model_extension(query)
		candidate_ext = model_extension(filename)
		if query_ext and candidate_ext and query_ext != candidate_ext:
			return 0
		query_key = compact_key(query)
		candidate_key = compact_key(filename)
		if not query_key or not candidate_key:
			return 0
		if candidate_key == query_key:
			return 100000
		if query_key in note_base_keys(filename) or candidate_key in note_base_keys(query):
			return 90000 + min(len(query_key), len(candidate_key))
		return 0

	def loose_suffix_reason(base_key, candidate_key):
		if not base_key or not candidate_key or base_key == candidate_key:
			return ""
		if candidate_key.startswith(base_key):
			suffix = candidate_key[len(base_key):]
		elif base_key.startswith(candidate_key):
			suffix = base_key[len(candidate_key):]
		else:
			return ""
		if suffix in LOOSE_NOTE_SUFFIXES:
			return f"模型主体一致，仅多出备注标记：{suffix}"
		return ""

	def loose_score_candidate(query, filename):
		query_key = compact_key(query)
		candidate_key = compact_key(filename)
		if not query_key or not candidate_key:
			return 0, ""

		query_ext = model_extension(query)
		candidate_ext = model_extension(filename)
		format_changed = bool(query_ext and candidate_ext and query_ext != candidate_ext)
		if query_key == candidate_key:
			reason = "模型主体一致，但文件格式/封装不同" if format_changed else "模型主体一致"
			return 70000, reason

		if query_key in note_base_keys(filename) or candidate_key in note_base_keys(query):
			reason = "模型主体一致，仅多出文件备注"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 69000 + min(len(query_key), len(candidate_key)), reason

		reason = loose_suffix_reason(query_key, candidate_key)
		if reason:
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 68000 + min(len(query_key), len(candidate_key)), reason

		query_signature = token_signature(query)
		candidate_signature = token_signature(filename)
		if len(query_signature) >= 3 and query_signature == candidate_signature:
			reason = "模型关键词一致，仅排列顺序不同"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 67000 + min(len(query_key), len(candidate_key)), reason

		query_rank_signature, query_rank_changed, query_has_lora = rank_variant_signature(query)
		candidate_rank_signature, candidate_rank_changed, candidate_has_lora = rank_variant_signature(filename)
		if (
			len(query_rank_signature) >= 3
			and query_rank_signature == candidate_rank_signature
			and (query_rank_changed or candidate_rank_changed)
			and (query_has_lora or candidate_has_lora or (query_rank_changed and candidate_rank_changed))
		):
			reason = "LoRA 主体一致，仅 rank/秩大小不同" if (query_has_lora or candidate_has_lora) else "模型主体一致，仅 rank/秩大小不同"
			if format_changed:
				reason += "，且文件格式/封装不同"
			return 66000 + min(len(query_key), len(candidate_key)), reason
		return 0, ""

	def expand_categories(raw_categories):
		available = set(getattr(folder_paths, "folder_names_and_paths", {}) or {})
		result = []
		def add(name):
			key = str(name or "").strip()
			if key and key in available and key not in result and key not in SKIP_FOLDERS:
				result.append(key)
		for raw in raw_categories or []:
			key = str(raw or "").strip()
			for alias in CATEGORY_ALIASES.get(key, (key,)):
				add(alias)
		if result:
			return result
		for key in available:
			add(key)
		return result

	def find_matches(query, categories, limit=8, allowed_values=None):
		cleaned = clean_model_key(query, basename_only=True)
		if not cleaned:
			return []
		allowed_items = [str(value or "").strip() for value in (allowed_values or []) if str(value or "").strip()]
		allowed = {path_key(value) for value in allowed_items}
		allowed_basenames = {basename_path_key(value) for value in allowed}
		def allowed_rank(filename):
			if not allowed:
				return 0
			key = path_key(filename)
			if key in allowed:
				return 2
			if basename_path_key(filename) in allowed_basenames:
				return 1
			return -1
		def collect(tier):
			scored = []
			if tier == "confirm" and not allowed:
				return []
			def add_scored(category, filename, rank):
				if tier == "strict":
					score = score_candidate(query, filename)
					reason = "严格匹配：仅目录、量化或备注不同"
				else:
					score, reason = loose_score_candidate(query, filename)
				if score <= 0:
					return
				short_len = len(compact_key(filename))
				scored.append((score, rank, path_depth(filename), short_len, str(filename).lower(), category, filename, reason))

			for filename in allowed_items:
				add_scored("widget_options", filename, 3)

			for category in expand_categories(categories):
				try:
					files = list(folder_paths.get_filename_list(category) or [])
				except Exception:
					continue
				for filename in files:
					rank = allowed_rank(filename)
					if rank < 0:
						continue
					add_scored(category, filename, rank)
			scored.sort(key=lambda item: (-item[0], -item[1], item[2], item[3], item[4]))
			seen = set()
			matches = []
			for score, _rank, _depth, _short_len, _lower, category, filename, reason in scored:
				key = (category, filename)
				if key in seen:
					continue
				seen.add(key)
				matches.append({
					"category": category,
					"name": filename,
					"score": score,
					"tier": tier,
					"needs_confirmation": tier == "confirm",
					"reason": reason,
					"cleaned_name": clean_model_key(filename, basename_only=True),
				})
				if len(matches) >= limit:
					break
			return matches

		strict_matches = collect("strict")
		if strict_matches:
			return strict_matches
		return collect("confirm")

	@server.routes.post("/gjj/summon_model")
	async def gjj_summon_model(request):
		try:
			data = await request.json()
		except Exception:
			data = {}
		raw_queries = data.get("queries")
		if not isinstance(raw_queries, list):
			raw_queries = [data]
		results = []
		for item in raw_queries:
			if not isinstance(item, dict):
				item = {}
			query = str(item.get("value") or item.get("query") or "").strip()
			categories = item.get("categories") or []
			allowed_values = item.get("allowed_values") or []
			limit = int(item.get("limit") or 8)
			matches = find_matches(query, categories, limit=max(1, min(limit, 30)), allowed_values=allowed_values)
			results.append({
				"id": item.get("id"),
				"widget_name": item.get("widget_name"),
				"source_value": query,
				"cleaned_query": clean_model_key(query, basename_only=True),
				"categories": expand_categories(categories),
				"ok": bool(matches),
				"match": matches[0] if matches else None,
				"matches": matches,
			})
		return web.json_response({"results": results})

	server._gjj_summon_model_api_registered = True
_register_gjj_summon_model_api()

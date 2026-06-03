print("\033[1;92m" + r"""
💛 ██████╗ ██╗   ██╗███████╗       ██╗ ██╗       ██╗██╗   ██╗███╗   ██╗💛
💛██╔════╝ ██║   ██║██╔══██║       ██║ ██║       ██║██║   ██║████╗  ██║💛
💛██║  ███╗██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██╔██╗ ██║💛
💛██║   ██║██║   ██║██║  ██║       ██║ ██║       ██║██║   ██║██║╚██╗██║💛
💛╚██████╔╝╚██████╔╝███████║ ╚██████╔╝╚██║ ╚██████╔╝╚██████╔╝██║ ╚████║💛
💛 ╚═════╝  ╚═════╝ ╚══════╝  ╚═════╝  ╚═╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝💛
""".strip() + "\033[0m")
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
		required_models = getattr(node_cls, "REQUIRED_MODELS", None)
		if help_data is None and required_models:
			help_data = {"models": required_models}
		payload[str(node_name)] = {
			"description": str(getattr(node_cls, "DESCRIPTION", "") or ""),
			"help": _serialize_help_value(help_data or {}),
		}
	return payload
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
	return {
		"version": 1,
		"workflow_screenshot": {
			"directory": "workflows",
			"filename_template": "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png",
			"sort_mode": "mtime_desc",
			"filter_mode": "all",
			"search_text": "",
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
		"nodes": {},
		"user": {},
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
	return {
		"directory": str(section.get("directory") or ""),
		"filename_template": str(section.get("filename_template") or "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png"),
		"sort_mode": str(section.get("sort_mode") or "mtime_desc"),
		"filter_mode": str(section.get("filter_mode") or "all"),
		"search_text": str(section.get("search_text") or ""),
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
		return _gjj_workflow_screenshot_settings().get("filename_template") or "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png"

	def legacy_default_directory() -> str:
		return os.path.abspath(os.path.join(folder_paths.get_output_directory(), LEGACY_DEFAULT_SUBDIR))

	def clean_filename(value: str) -> str:
		name = os.path.basename(str(value or "").strip()) or "GJJ_workflow.png"
		name = SAFE_FILENAME_RE.sub("_", name).strip(" .")
		if not name:
			name = "GJJ_workflow.png"
		if not name.lower().endswith(".png"):
			name += ".png"
		return name[:180]

	def resolve_directory(value: str | None) -> str:
		raw = str(value or "").strip()
		path = _gjj_expand_setting_path(raw, default_directory())
		os.makedirs(path, exist_ok=True)
		return path

	def png_path(directory: str, filename: str) -> str:
		base = resolve_directory(directory)
		name = clean_filename(filename)
		path = os.path.abspath(os.path.join(base, name))
		if os.path.dirname(path) != base:
			raise ValueError("文件名不安全。")
		return path

	def newest_png_path(directory: str) -> str:
		base = resolve_directory(directory)
		newest = ""
		newest_mtime = -1.0
		for entry in Path(base).glob("*.png"):
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

	def decode_png_data(value: str) -> bytes:
		text = str(value or "")
		if "," in text and text.lower().startswith("data:"):
			text = text.split(",", 1)[1]
		data = base64.b64decode(text, validate=False)
		if not data.startswith(b"\x89PNG\r\n\x1a\n"):
			raise ValueError("只支持 PNG 工作流截图。")
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
				"filter_mode": _gjj_workflow_screenshot_settings().get("filter_mode") or "all",
				"search_text": _gjj_workflow_screenshot_settings().get("search_text") or "",
			},
		})

	@server.routes.post("/gjj/workflow_screenshot/save")
	async def gjj_workflow_screenshot_save(request):
		try:
			data = await request.json()
			directory = resolve_directory(data.get("directory"))
			filename = clean_filename(data.get("filename"))
			path = png_path(directory, filename)
			raw = decode_png_data(data.get("image") or data.get("png") or "")
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
			for entry in sorted(Path(directory).glob("*.png"), key=lambda item: item.stat().st_mtime, reverse=True):
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
					"filter_mode": _gjj_workflow_screenshot_settings().get("filter_mode") or "all",
					"search_text": _gjj_workflow_screenshot_settings().get("search_text") or "",
				},
				"items": items,
			})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc), "items": []}, status=400)

	@server.routes.get("/gjj/workflow_screenshot/file")
	async def gjj_workflow_screenshot_file(request):
		try:
			path = png_path(request.query.get("directory"), request.query.get("filename"))
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
					candidate = png_path(directory, filename)
					if os.path.exists(candidate):
						select_path = candidate
				except Exception:
					select_path = ""
			if select_file and not select_path:
				last_path = os.path.abspath(str(getattr(server, "_gjj_workflow_screenshot_last_path", "") or ""))
				if os.path.exists(last_path) and os.path.dirname(last_path) == directory:
					select_path = last_path
			if select_file and not select_path:
				select_path = newest_png_path(directory)

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
		"audio_encoder": ("audio_encoders",),
		"audio_encoders": ("audio_encoders",),
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

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
			"page_size": 12,
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
		"ollama_assistant": ollama_assistant,
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
	try:
		page_size = int(section.get("page_size") or 12)
	except Exception:
		page_size = 12
	page_size = max(1, min(100, page_size))
	return {
		"directory": str(section.get("directory") or ""),
		"filename_template": str(section.get("filename_template") or "{title}_{yyyy}{MM}{dd}_{HH}{mm}{ss}.png"),
		"sort_mode": str(section.get("sort_mode") or "mtime_desc"),
		"filter_mode": str(section.get("filter_mode") or "openable"),
		"search_text": str(section.get("search_text") or ""),
		"page_size": page_size,
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
				"page_size": _gjj_workflow_screenshot_settings().get("page_size") or 12,
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
					"page_size": _gjj_workflow_screenshot_settings().get("page_size") or 12,
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
		from PIL import Image, ImageFilter
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
		path = (models_dir / "mp3").resolve()
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
		if not parts or not parts[-1].lower().endswith(".mp3"):
			return ""
		return "/".join(parts)[:220]

	def voice_path_from_relative(relative_path: str) -> Path:
		clean = clean_voice_path(relative_path)
		if not clean:
			raise ValueError("音色路径无效，只支持 models/mp3 下的 mp3 文件。")
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
			relative = f"{name}.mp3"
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
		data = dict(data)
		data["views"] = views
		data["cover"] = views[0]["url"] if views else ""
		data["cover_view"] = views[0]["id"] if views else ""
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

	def comprehensive_matting_cutouts(images: list[Image.Image]) -> list[Image.Image]:
		try:
			from .nodes.gjj_comprehensive_matting import (
				GJJ_ComprehensiveMatting,
				METHOD_RMBG14,
				MODEL_DOWNLOAD_URL,
				_pil_list_to_tensor,
				_resolve_model_path,
				_tensor_to_pil_list,
			)
		except Exception as exc:
			raise RuntimeError(f"加载综合抠图运行时失败：{exc}") from exc
		try:
			_resolve_model_path(METHOD_RMBG14, notify_missing=False)
		except Exception as exc:
			raise RuntimeError(
				f"未找到 RMBG1.4 抠图模型：models/RMBG/rmbg1.4.safetensors。{exc}\n{MODEL_DOWNLOAD_URL}"
			) from exc
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
				matting_method=METHOD_RMBG14,
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
		base = ["大头照", "正面", "左侧", "右侧", "背面", "45度", "半身", "表情", "动作"]
		return [base[index] if index < len(base) else f"视图{index + 1}" for index in range(count)]

	def labels_for_multiview(count: int) -> list[str]:
		base = ["大头照", "正面", "45度", "背面"]
		return [base[index] if index < len(base) else f"视图{index + 1}" for index in range(count)]

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
		return write_manifest(manifest)

	def save_view_image(character_id: str, label: str, image: Image.Image) -> dict:
		return save_view_bytes(character_id, label, png_bytes(image))

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
		return web.json_response({
			"ok": True,
			"title": "角色库模型树",
			"groups": [
				{
					"name": "🪄 抠图",
					"items": [
						{"label": "GJJ_ComprehensiveMatting", "path": "custom_nodes/ComfyUI_GJJ_Nodes/nodes/gjj_comprehensive_matting.py"},
						{"label": "RMBG1.4", "path": "models/RMBG/rmbg1.4.safetensors"},
					],
				},
				{
					"name": "🚀 生成多视图",
					"items": [
						{"label": "GJJ_CharacterMultiViewStudio", "path": "custom_nodes/ComfyUI_GJJ_Nodes/nodes/gjj_character_multiview_studio.py"},
						{"label": "UNET", "path": "models/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors"},
						{"label": "CLIP / VL", "path": "models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"},
						{"label": "VAE", "path": "models/vae/qwen_image_vae.safetensors"},
						{"label": "Lightning LoRA", "path": "models/loras/QWEN/lighting/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"},
						{"label": "多角度 LoRA", "path": "models/loras/qwen-image-edit-2511-multiple-angles-lora.safetensors"},
					],
				},
				{
					"name": "🧠 备注/性别推理",
					"items": [
						{"label": "GJJ_GemmaTextGenerate", "path": "custom_nodes/ComfyUI_GJJ_Nodes/nodes/gjj_gemma_text_generate.py"},
						{"label": "Gemma / Qwen VL 文本编码器", "path": "models/text_encoders/qwen3.5_4b_fp8_mixed.safetensors"},
					],
				},
				{
					"name": "👤 人物库存储",
					"items": [
						{"label": "角色库", "path": str(root_dir())},
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
					if old_path.exists():
						if new_path.exists():
							raise ValueError(f"角色文件夹已存在：{next_id}")
						old_path.rename(new_path)
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
				raise ValueError("缺少音色 mp3 文件。")
			if not file_name.lower().endswith(".mp3"):
				raise ValueError("音色只支持 mp3 文件。")
			target_name = clean_key(fields.get("voice_path") or file_name or f"{character_reference_name(manifest, character_id)}.mp3", "voice.mp3")
			if not target_name.lower().endswith(".mp3"):
				target_name += ".mp3"
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
			for path in sorted(base.rglob("*.mp3"), key=lambda item: str(item.relative_to(base)).lower()):
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
				base_prompt = str(fields.get("base_prompt") or "").strip()
				seed = int(fields.get("seed") or 0)
			else:
				data = await request.json()
				name = str(data.get("name") or "").strip()
				character_id = clean_key(data.get("id") or name, "character")
				image = decode_image(data.get("image") or data.get("png") or "")
				base_prompt = str(data.get("base_prompt") or "").strip()
				seed = int(data.get("seed") or 0)
			manifest = read_manifest(character_id)
			manifest["name"] = name or manifest.get("name") or character_id
			write_manifest(manifest)

			try:
				from .nodes.gjj_comprehensive_matting import _pil_list_to_tensor, _tensor_to_pil_list
				from .nodes.gjj_character_multiview_studio import (
					DEFAULT_EXTRA_PROMPT,
					DEFAULT_MULTI_ANGLES_LORA,
					DEFAULT_NEGATIVE_PROMPT,
					DEFAULT_QWEN2511_LIGHTNING_LORA,
					DEFAULT_QWEN2511_UNET,
					GJJ_CharacterMultiViewStudio,
					_pick_available_lora_name,
					_safe_filename_list,
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

			identity_prompt = (
				"图一只作为人物身份、五官、发型、服装配色和风格参考；不要继承图一的近景构图、裁切范围、白条、背景边缘或镜头距离。"
				"除大头照外，其余视图必须重新拉远镜头生成完整人体。"
			)
			if base_prompt:
				identity_prompt = f"{identity_prompt}\n{base_prompt}"
			action_prompts = "\n".join([
				"白色背景,近距离大头特写，只拍头部和肩膀，构图紧凑，清晰保留完整面部特征，人物资产。",
				"白色背景,标准正面,远景全身照,镜头拉远,完整全身构图,从头顶到双脚全部可见,完整人体,双脚完整在画面内,不要大头照,不要半身照,不要裁脚,画面底部预留足够空间容纳双脚。",
				"白色背景,主体45°斜侧身,远景全身照,镜头拉远,全身无裁剪,从头到脚全部可见,姿态自然,不要大头照,不要半身照,不要裁脚。顶部、底部各留白5%，居中人物资产。",
				"白色背景,主体后视图,远景全身照,镜头拉远,全身无裁剪,从头到脚全部可见,轮廓标准,不要大头照,不要半身照,不要裁脚。顶部、底部各留白5%，居中人物资产。",
			])
			lora_models = _safe_filename_list("loras") or []
			def lora_exists(name: str) -> bool:
				target = os.path.basename(str(name or "").replace("\\", "/")).lower()
				return bool(target) and any(os.path.basename(str(item or "").replace("\\", "/")).lower() == target for item in lora_models)
			lora_1_name = _pick_available_lora_name(
				lora_models,
				DEFAULT_QWEN2511_LIGHTNING_LORA,
				DEFAULT_QWEN2511_LIGHTNING_LORA,
			)
			lora_2_name = _pick_available_lora_name(
				lora_models,
				DEFAULT_MULTI_ANGLES_LORA,
				DEFAULT_MULTI_ANGLES_LORA,
			)
			if not lora_exists(lora_1_name) or not lora_exists(lora_2_name):
				raise RuntimeError("生成多视图必须使用 Qwen Lightning LoRA 和 multiple-angles LoRA，但未在 models/loras 中找到。")

			main_image = _pil_list_to_tensor([fit_character_reference_canvas(image, 1024, 1280)])
			context_unique_id = "gjj_character_library_multiview"
			had_last_prompt_id = hasattr(server, "last_prompt_id")
			if not had_last_prompt_id:
				try:
					setattr(server, "last_prompt_id", context_unique_id)
				except Exception:
					pass
			try:
				_collage, batch_images = GJJ_CharacterMultiViewStudio().generate(
					main_image=main_image,
					base_prompt=identity_prompt,
					negative_prompt=DEFAULT_NEGATIVE_PROMPT,
					action_prompts=action_prompts,
					unet_name=DEFAULT_QWEN2511_UNET,
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
			finally:
				if not had_last_prompt_id and hasattr(server, "last_prompt_id"):
					try:
						delattr(server, "last_prompt_id")
					except Exception:
						pass

			generated = _tensor_to_pil_list(batch_images)
			if not generated:
				raise RuntimeError("多视图节点没有返回单图批量图片。")
			views = comprehensive_matting_cutouts(generated)
			labels = labels_for_multiview(len(views))
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
			clip_name = str(data.get("clip_name") or "qwen3.5_4b_fp8_mixed.safetensors")
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
			return web.json_response({"ok": True, "character": enrich_manifest(write_manifest(manifest))})
		except Exception as exc:
			return web.json_response({"ok": False, "error": str(exc)}, status=400)

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

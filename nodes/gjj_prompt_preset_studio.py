from __future__ import annotations

import json
import random
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from aiohttp import web

try:
	from ..utils.tsv_translation import DEFAULT_TRANSLATION_TSV, load_translation_table, normalize_translation_text
except Exception:
	from utils.tsv_translation import DEFAULT_TRANSLATION_TSV, load_translation_table, normalize_translation_text

try:
	from server import PromptServer
except Exception:
	PromptServer = None


NODE_NAME = "GJJ_PromptPresetStudio"
# 查找预设文件路径：从当前文件向上查找，直到找到包含 presets/prompt_presets 目录的位置
def _find_preset_root() -> Path:
	"""动态查找预设文件根目录（必须包含 prompt_presets 子目录）。"""
	current = Path(__file__).resolve().parent
	# 向上最多查找5级目录
	for _ in range(5):
		presets_dir = current / "presets"
		if presets_dir.exists() and presets_dir.is_dir():
			# 检查是否包含 prompt_presets 子目录，确保找到的是正确的 presets 目录
			if (presets_dir / "prompt_presets").exists():
				return presets_dir
		current = current.parent
	# 如果找不到，回退到默认位置（相对于当前文件的三级父目录）
	return Path(__file__).resolve().parent.parent.parent / "presets"

PRESET_ROOT = _find_preset_root() / "prompt_presets"
PROMPT_PRESET_STYLES_API_PATH = "/gjj/prompt_preset_styles"
PROMPT_PRESET_SCHEMA_API_PATH = "/gjj/prompt_preset_schema"
LABEL_TRANSLATIONS_PATH = DEFAULT_TRANSLATION_TSV
LEGACY_LABEL_TRANSLATIONS_PATH = PRESET_ROOT / "label_translations.json"
CONFIG_STORE_WIDGET = "配置存储"
OPTION_NONE = "无"
OPTION_RANDOM = "随机"
OPTION_OFF = "关闭"
OPTION_ON = "启用"
OPTION_SEPARATOR = "｜"
STYLE_MODE_OPTIONS = [OPTION_OFF, "单风格", "多风格"]
DETAIL_MODE_OPTIONS = ["详细", "简洁"]
NEGATIVE_PRESET_OPTIONS = ["关闭", "通用写实", "动漫插画", "证件照", "产品白底"]

ID_PHOTO_OPTIONS: dict[str, list[str]] = {
	"证件照构图": ["无", "随机", "人像面部特写", "上半身近景特写", "中近景构图", "半身构图", "七分身构图"],
	"证件照国籍": ["无", "随机", "中国", "日本", "韩国", "东南亚", "印度", "中东", "俄罗斯", "北欧", "西欧", "南欧", "北美", "南美", "非洲", "原住民", "混血"],
	"证件照性别": ["无", "随机", "女孩", "男孩", "女人", "男人", "老人", "老奶奶", "老爷爷", "小女孩", "小男孩", "女婴儿", "男婴儿"],
	"证件照体型": ["无", "随机", "纤细的", "苗条的", "丰满的", "肌肉发达的", "娇小的", "高挑的", "肥胖的"],
	"证件照发色": ["无", "随机", "黑色", "蓝黑色", "茶黑色", "深棕色", "巧克力棕", "亚麻棕", "青木棕", "香槟金", "酒红色", "莓果红", "橘红色", "奶奶灰", "雾霾灰", "灰紫色", "蓝灰色", "孔雀蓝", "樱花粉", "玫瑰粉", "粉紫色", "奶茶色", "薰衣草紫", "珊瑚橙", "渐变色"],
	"证件照发型": ["无", "随机", "飘逸长发", "波波头", "精灵短发", "露耳短发", "空气刘海", "中长发", "锁骨发", "波浪卷", "法式刘海", "齐刘海", "长发", "大波浪", "黑长直", "公主切", "高马尾", "复古背头", "复古卷发", "单马尾辫", "双马尾辫", "脏辫（Dreadlocks）", "丸子头发", "头包脸发型"],
	"证件照服装颜色": ["无", "随机", "中性色", "黑色", "白色", "灰色", "米色", "卡其色", "驼色", "冷色", "藏青色", "天蓝色", "宝蓝色", "浅蓝色", "墨绿色", "军绿色", "浅绿色", "暖色", "红色", "酒红色", "浅红色", "粉色", "玫粉色", "浅粉色", "橙色", "黄色", "浅黄色", "紫色", "浅紫色", "深紫色", "棕色", "咖啡色", "牛仔蓝", "荧光色", "荧光黄", "荧光绿", "金色", "银色"],
	"证件照服装款式": ["无", "随机", "V领T恤", "圆领T恤", "衬衫", "V领衬衫", "POLO衫", "泡泡袖", "毛衣", "卫衣", "夹克", "西装外套", "V领正装", "风衣", "皮衣", "羽绒服", "高档婚纱", "高档礼服", "马甲", "连衣裙", "牛仔衣", "军装", "警服", "护士服", "厨师服", "校服", "白大褂", "睡衣", "旗袍", "包臀裙", "背带裤", "春装", "夏装", "秋装", "冬装"],
	"证件照服饰佩饰": ["无", "随机", "领带", "格子领带", "斜纹领带", "领结", "蝴蝶结", "腰带", "围巾"],
	"证件照妆容": ["无", "随机", "素颜", "淡妆", "日常妆", "清新妆", "素颜妆", "职场妆", "烟熏妆", "晚晏妆", "新娘妆", "舞台妆", "韩系妆", "日系妆", "中式古典妆", "复古妆", "欧美妆", "纯欲妆"],
	"证件照表情": ["无", "随机", "微笑", "大笑", "抿嘴笑", "甜甜的笑容和洁白的牙齿", "冷漠的表情", "冷笑"],
	"证件照背景色": ["无", "随机", "简单背景", "中性色", "黑色", "白色", "灰色", "米色", "卡其色", "驼色", "冷色", "藏青色", "天蓝色", "宝蓝色", "浅蓝色", "墨绿色", "军绿色", "浅绿色", "暖色", "红色", "酒红色", "浅红色", "粉色", "玫粉色", "浅粉色", "橙色", "黄色", "浅黄色", "紫色", "浅紫色", "深紫色", "棕色", "咖啡色", "牛仔蓝", "荧光色", "荧光黄", "荧光绿", "金色", "银色"],
	"证件照其他佩饰": ["无", "随机", "帽子", "眼镜", "细框眼镜", "粗框眼镜", "耳环", "耳钉", "项链", "头花", "发箍"],
}

SUBJECT_SPECS = [
	("subject_character", "Character", "主体·角色", "主体角色、IP 人物或主体原型。"),
	("subject_type", "Subject Type", "主体·类型", "主体类型，例如人物、动物、机械或奇幻生物。"),
	("subject_action", "Action", "主体·动作", "主体当前的主要动作。"),
	("subject_action_plus", "Action+", "主体·动作强化", "给主体动作增加一个补充细节。"),
	("subject_action_plus_plus", "Action++", "主体·动作强化2", "再补充一层动作或状态细节。"),
	("subject_positioning", "Positioning", "主体·站位", "主体的站位、摆位或身体方向。"),
	("subject_hair", "Hair", "主体·发型", "基础发型或毛发状态。"),
	("subject_rare_hairstyle", "Rare Hairstyle", "主体·特殊发型", "更夸张或更少见的发型变化。"),
	("subject_rare_hairstyle_man", "Rare Hairstyle Man", "主体·男向特殊发型", "适合男性主体的特殊发型。"),
	("subject_rare_hair_colors", "Rare Hair Colors", "主体·特殊发色", "非常规发色。"),
	("subject_head_accessories", "Head Accessories", "主体·头部饰品", "帽子、头冠、头饰等。"),
	("subject_face", "Face", "主体·面部特征", "脸部状态、表情或细节。"),
	("subject_ears", "Ears", "主体·耳部特征", "耳朵、耳饰或种族特征。"),
	("subject_neck", "Neck", "主体·颈部细节", "围巾、领口、项圈等。"),
	("subject_skin", "Skin", "主体·皮肤细节", "肤色、肌理或材质特征。"),
	("subject_clothing", "Clothing", "主体·服装", "主体主服装。"),
	("subject_upper_body_decoration", "Upper Body Decoration", "主体·上身装饰", "上半身附加配件。"),
	("subject_lower_body_decoration", "Lower Body Decoration", "主体·下身装饰", "下半身附加配件。"),
	("subject_full_body_decoration", "Full body decoration", "主体·全身装饰", "贯穿全身的装饰元素。"),
	("subject_shoes_and_socks", "Shoes and socks", "主体·鞋袜", "鞋子、袜子与足部穿搭。"),
	("subject_accessories", "Accessories", "主体·配件", "耳饰、首饰、道具或外挂配件。"),
]

ENVIRONMENT_SPECS = [
	("env_sky", "Sky", "环境·天空", "天空、星空、天气与顶部空间氛围。"),
	("env_indoor", "Indoor", "环境·室内", "室内环境类型。"),
	("env_outdoor", "Outdoor", "环境·户外", "户外空间类型。"),
	("env_building", "Building", "环境·建筑", "建筑主体或建筑风格。"),
	("env_flowers", "Flowers", "环境·花卉", "花卉元素或花海背景。"),
	("env_background", "Background", "环境·背景", "通用背景装饰或背景主体。"),
]

RANDOM_SPECS = [
	("random_woman", "0_1Woman.txt", "随机灵感·女性主体"),
	("random_man", "0_2Man.txt", "随机灵感·男性主体"),
	("random_fictional_character", "0_3Fictional_Character.txt", "随机灵感·虚构角色"),
	("random_humanoids", "0_4Humanoids.txt", "随机灵感·类人生物"),
	("random_animals", "0_5Animals.txt", "随机灵感·动物"),
	("random_vehicles", "0_6Vehicles.txt", "随机灵感·交通工具"),
	("random_shotstyle", "1_0Shotstyle.txt", "随机灵感·镜头风格"),
	("random_angle_of_view", "1_1Angle_of_View.txt", "随机灵感·视角"),
	("random_locations", "1_2Locations.txt", "随机灵感·地点"),
	("random_artists", "1_3Artists.txt", "随机灵感·艺术家"),
	("random_artists_special", "1_4Artists_Special.txt", "随机灵感·特殊艺术家"),
	("random_cameras", "1_5Cameras.txt", "随机灵感·相机"),
	("random_lighting", "1_6Lighting.txt", "随机灵感·灯光"),
	("random_adelai_artists", "2_0AdelAi_Artists.txt", "随机灵感·AdelAI艺术家"),
	("random_adelai_styles", "2_1AdelAi_Styles.txt", "随机灵感·AdelAI风格"),
	("random_adelai_fx", "2_2AdelAi_FX.txt", "随机灵感·AdelAI特效"),
	("random_adelai_lighting", "2_3AdelAi_Lighting.txt", "随机灵感·AdelAI灯光"),
	("random_adelai_cameras", "2_4AdelAi_Cameras.txt", "随机灵感·AdelAI相机"),
	("random_adelai_films", "2_5AdelAi_Films.txt", "随机灵感·AdelAI胶片"),
]

ID_PHOTO_FIELDS = list(ID_PHOTO_OPTIONS.keys())
ANGLE_FIELDS = ["视角旋转", "视角俯仰", "镜头远近", "视角描述"]
SUBJECT_FIELDS = [internal_name for internal_name, _source_key, _display_name, _tooltip in SUBJECT_SPECS]
ENVIRONMENT_FIELDS = [internal_name for internal_name, _source_key, _display_name, _tooltip in ENVIRONMENT_SPECS]
RANDOM_FIELDS = [field_name for field_name, _filename, _display_name in RANDOM_SPECS]

NEGATIVE_PRESETS = {
	"关闭": "",
	"通用写实": "lowres, blurry, bad anatomy, bad hands, deformed, duplicate, watermark, text, logo, jpeg artifacts, cropped, out of frame",
	"动漫插画": "realistic photo, 3d, render, blurry, lowres, bad anatomy, extra fingers, watermark, text, logo",
	"证件照": "side face, profile pose, messy hair, cluttered background, multiple people, occluded face, exaggerated expression, lowres, watermark",
	"产品白底": "people, hands, clutter, complex background, watermark, logo, text, extra objects, messy reflection, lowres",
}

PHRASE_TRANSLATIONS = {
	"bed and breakfast": "民宿",
	"style by ": "风格来自",
	"abstract photography": "抽象摄影",
	"action photography": "动作摄影",
	"analogue photography": "胶片摄影",
	"artistic photography": "艺术摄影",
	"astrophotography": "天体摄影",
	"b&w photography": "黑白摄影",
	"beauty photography": "美妆摄影",
	"candid photography": "抓拍摄影",
	"documentary photography": "纪实摄影",
	"dreamy haze photography": "梦幻朦胧摄影",
	"erotic photography": "性感摄影",
	"glamour photography": "魅力时尚摄影",
	"anaglyph 3d photography": "红蓝立体摄影",
	"bloom effect": "泛光效果",
	"bokeh effect": "散景效果",
	"chromatic aberration": "色差效果",
	"depth of field": "景深效果",
	"desaturated grunge filter": "低饱和粗粝滤镜",
	"diffraction spikes effect": "衍射星芒效果",
	"double exposure": "双重曝光",
	"foreshortening effect": "透视缩短效果",
	"glitch style": "故障艺术风格",
	"artificial indoor lighting": "室内人工布光",
	"back lit": "背光",
	"backlight": "背光布光",
	"backlighting": "逆光布光",
	"beautifully lit": "优美布光",
	"bloom light": "柔辉光",
	"bounced lighting": "反射补光",
	"bright and sunny": "明亮晴天光效",
	"broad lighting": "宽光布光",
	"candle light": "烛光",
	"candlelit scene": "烛光场景",
	"cinematic lighting": "电影感布光",
	"city lights": "城市灯光",
	"chiaroscuro": "明暗对照",
	"compact camera": "便携相机",
	"canon 5d mark 4": "佳能 5D Mark IV 相机",
	"canon ef": "佳能 EF 镜头",
	"canon eos 5d mark 4": "佳能 EOS 5D Mark IV 相机",
	"canon r5": "佳能 R5 相机",
	"canon rf": "佳能 RF 镜头",
	"daguerrotype": "银版摄影",
	"dim and cozy": "昏暗温馨氛围",
	"direct light": "直射光",
	"dramatic high contrast": "戏剧性高对比光效",
	"dramatic spotlight": "戏剧性聚光",
	"dslr": "单反相机",
	"edge lighting": "轮廓光",
	"film camera": "胶片相机",
	"fine grain": "细颗粒",
	"fomapan 400": "Fomapan 400 胶片",
	"golden hour light": "黄金时刻光线",
	"hair light": "发丝轮廓光",
	"hard light": "硬光",
	"hard shadows": "硬阴影",
	"hasselblad": "哈苏相机",
	"high speed liquid": "高速液体定格",
	"indirect light": "间接光",
	"intense firelight": "强烈火光",
	"iphone x": "iPhone X 手机",
	"key light": "主光",
	"lens flare": "镜头光晕",
	"light & shadow": "光与影",
	"light and shadow plays": "光影交错",
	"light caustics": "焦散光影",
	"light painting": "光绘",
	"lomochrome color film": "Lomochrome 彩色胶片",
	"lomography color 100": "Lomography Color 100 胶片",
	"long exposure": "长曝光",
	"motion blur": "动态模糊",
	"multiple exposure": "多重曝光",
	"muted low grain": "低颗粒低饱和",
	"natural sunlight": "自然阳光",
	"neutral density filters": "中性密度滤镜",
	"nikon d3300": "尼康 D3300 相机",
	"nikon d850": "尼康 D850 相机",
	"nikon z6 ii mirrorless": "尼康 Z6 II 微单相机",
	"nikon z7 ii mirrorless": "尼康 Z7 II 微单相机",
	"nikon z9": "尼康 Z9 相机",
	"overexposed": "过曝",
	"phase one xf iq4 150mp": "Phase One XF IQ4 150MP 相机",
	"polaroid": "宝丽来相机",
	"porta 160": "Porta 160 胶片",
	"prominent grain": "明显颗粒",
	"red digital cinema camera": "RED 数字电影机",
	"reflected light": "反射光",
	"rolleiflex analogshot": "Rolleiflex 胶片相机",
	"samsung galaxy": "Samsung Galaxy 手机",
	"selective color": "选择性色彩",
	"sepia tone": "棕褐色调",
	"short exposure": "短曝光",
	"side lit": "侧光",
	"soft focus": "柔焦",
	"soft illumination": "柔和照明",
	"soft shadows": "柔和阴影",
	"solarized": "曝光反转",
	"sony a7": "索尼 A7 相机",
	"split tone": "分离色调",
	"spotlight": "聚光灯",
	"spotlit": "聚光照明",
	"subdued nightlight": "低调夜灯光",
	"subtle ambient glow": "微弱环境辉光",
	"sunlight": "阳光",
	"technicolor": "特艺色彩",
	"tri-x 400 b&w": "Tri-X 400 黑白胶片",
	"ultraviolet light": "紫外光",
	"underwater illumination": "水下照明",
	"velvia 100": "Velvia 100 胶片",
	"vivid art gallery spotlights": "鲜明画廊聚光",
	"waning light": "渐弱光线",
	"high angle": "高角度",
	"low angle": "低角度",
	"bird's eye view": "鸟瞰",
	"worm's eye view": "仰视",
	"wide shot": "远景",
	"medium shot": "中景",
	"close-up": "近景特写",
	"extreme close-up": "超特写",
	"top-down": "俯视",
	"front view": "正面视角",
	"back view": "背面视角",
	"side view": "侧面视角",
	"holding": "持物",
	"\\||/": "欢呼手势",
	"\\m/": "金属礼手势",
	"\\n/": "剪刀手变体",
	"adjusting eyewear": "整理眼镜",
	"adjusting hair": "整理头发",
	"adjusting legwear": "整理腿部服饰",
	"adjusting panties": "整理内裤",
	"air guitar": "空气吉他",
	"air quotes": "引号手势",
	"akanbe": "吐舌做鬼脸",
	"all fours": "四肢着地",
	"arched back": "拱背",
	"arm around neck": "手臂绕颈",
	"arm grab": "抓住手臂",
	"arm held back": "手臂后收",
	"arm hug": "搂住手臂",
	"arm support": "手臂支撑",
	"arm up": "单臂抬起",
	"armpit peek": "微露腋下",
	"armpits": "露腋",
	"arms around neck": "双臂绕颈",
	"arms at sides": "双臂垂于身侧",
	"arms behind back": "双臂置于背后",
	"arms behind head": "双臂置于脑后",
	"arms crossed": "双臂交叉",
	"arms up": "双臂举起",
	"back-to-back": "背靠背",
	"balancing": "保持平衡",
	"battoujutsu stance": "拔刀术姿势",
	"beckoning": "招手示意",
	"belly grab": "抓腹",
	"bent over": "俯身",
	"bikini pull": "拉扯比基尼",
	"bowing": "鞠躬",
	"bunching hair": "拢起头发",
	"bunny pose": "兔女郎姿势",
	"butterfly sitting": "蝴蝶坐姿",
	"ass focus": "臀部焦点",
	"back focus": "背部焦点",
	"cropped arms": "裁切手臂",
	"cropped legs": "裁切腿部",
	"cropped shoulders": "裁切肩部",
	"cropped torso upper body": "裁切上半身躯干",
	"cropped torso": "裁切躯干",
	"eye contact": "眼神接触",
	"facing away": "背向镜头",
	"facing viewer": "面向镜头",
	"female pov": "女性主观视角",
	"foot focus": "足部焦点",
	"full body": "全身",
	"looking afar": "望向远方",
	"looking at another": "看向另一人",
	"looking at phone": "看向手机",
	"looking at viewer": "看向镜头",
	"looking away": "移开视线",
	"looking back": "回头看",
	"looking down": "向下看",
	"looking to the side": "看向侧面",
	"looking up": "向上看",
	"lower body": "下半身",
	"peeping": "探头偷看",
	"pov crotch": "胯部主观视角",
	"pov hands": "双手主观视角",
	"selfiemirror": "镜前自拍",
	"sideways glance": "侧目",
	"solo focus": "单人焦点",
	"staring": "凝视",
	"straight-on": "正对镜头",
	"taking picture": "拍照中",
	"upper body": "上半身",
	"upshirt": "掀上衣",
	"upshorts": "掀短裤",
	"upskirt": "掀裙视角",
	"aerial shot": "航拍镜头",
	"aerial view": "航拍视角",
	"angle from above": "从上方取景",
	"angle from below": "从下方取景",
	"birds-eye-view shot": "鸟瞰镜头",
	"body shot": "半身镜头",
	"cinematic shot": "电影感镜头",
	"close-up shot": "近景特写镜头",
	"dolly zoom": "推拉变焦",
	"dutch angle shot": "荷兰倾斜镜头",
	"establishing shot": "环境建立镜头",
	"extreme close-up shot": "超特写镜头",
	"extreme wide shot": "超远景镜头",
	"eye-level shot": "平视镜头",
	"full body shot": "全身镜头",
	"full length frame": "全身构图",
	"full shot": "全景镜头",
	"ground level shot": "地面机位镜头",
	"high angle shot": "高角度镜头",
	"hip level shot": "腰平机位镜头",
	"knee level shot": "膝平机位镜头",
	"long shot": "远景镜头",
	"low angle shot": "低角度镜头",
	"medium close-up shot": "中近景镜头",
	"medium wide shot": "中远景镜头",
	"over the shoulder shot": "过肩镜头",
	"overhead angle": "俯拍角度",
	"pov shot": "主观镜头",
	"professionally shot": "专业拍摄",
	"rear angle": "背面角度",
	"selfie shot angle": "自拍机位",
	"shot from behind": "背后取景",
	"shot from side": "侧面取景",
	"shoulder-level shot": "肩平机位镜头",
	"side view shot": "侧面镜头",
	"side-profile": "侧脸轮廓",
	"street level shot": "街平机位镜头",
	"studio shot": "影棚镜头",
	"telephoto shot": "长焦镜头",
	"top-down view": "俯视视角",
	"two shot angle": "双人镜头角度",
	"upper body shot": "上半身镜头",
	"wide angle": "广角视角",
	"zoomed out": "拉远镜头",
	"high angle view": "高角度视角",
	"low angle view": "低角度视角",
	"medium full shot": "七分身镜头",
	"overhead shot view": "俯拍视角",
	"seen from above view": "从上方视角",
	"seen from behind": "从背后视角",
	"seen from below view": "从下方视角",
	"selfie view": "自拍视角",
	"straight on view": "正对视角",
	"top down view": "顶视视角",
	"wide angle view": "广角视角",
	"night sky": "夜空",
	"starry sky": "星空",
	"full moon": "满月",
	"blue moon": "蓝月",
	"shooting star": "流星",
	"sunburst background": "放射光背景",
	"living room": "客厅",
	"dining room": "餐厅",
	"dressing room": "更衣室",
	"staff room": "休息室",
	"storage room": "储物间",
	"hotel room": "酒店房间",
	"otaku room": "宅房",
	"messy room": "凌乱房间",
	"prison cell": "牢房",
	"ferris wheel": "摩天轮",
	"floating city": "漂浮城市",
	"floating island": "浮空岛",
	"flower field": "花田",
	"parking lot": "停车场",
	"phone booth": "电话亭",
	"market stall": "市场摊位",
	"mountain pass": "山口",
	"mountain peak": "山峰",
	"mountain ski slope": "滑雪坡",
	"music festival campground": "音乐节营地",
	"neighborhood park": "社区公园",
	"quiet suburban street": "安静郊区街道",
	"riverside": "河畔",
	"riverside bed and breakfast": "河畔民宿",
}

TOKEN_TRANSLATIONS = {
	"a": "",
	"an": "",
	"and": "与",
	"from": "来自",
	"of": "的",
	"the": "",
	"beautiful": "美丽",
	"abstract": "抽象",
	"action": "动作",
	"analogue": "胶片",
	"artistic": "艺术",
	"beauty": "美妆",
	"candid": "抓拍",
	"cinematic": "电影感",
	"cozy": "温馨",
	"contrast": "对比",
	"defocused": "虚焦",
	"desaturated": "低饱和",
	"detailed": "细节丰富",
	"documentary": "纪实",
	"dreamy": "梦幻",
	"edge": "边缘",
	"effect": "效果",
	"erotic": "性感",
	"filter": "滤镜",
	"glamour": "魅力",
	"glitch": "故障",
	"grunge": "粗粝",
	"haze": "朦胧",
	"sky": "天空",
	"cloud": "云",
	"cloudy": "多云",
	"day": "白天",
	"dusk": "黄昏",
	"autumn": "秋季",
	"spring": "春季",
	"summer": "夏季",
	"winter": "冬季",
	"rain": "雨",
	"rainy": "雨天",
	"moon": "月亮",
	"moonlight": "月光",
	"night": "夜晚",
	"stars": "星星",
	"sun": "太阳",
	"sunset": "日落",
	"indoor": "室内",
	"outdoor": "户外",
	"lighting": "布光",
	"lights": "灯光",
	"photography": "摄影",
	"scene": "场景",
	"spikes": "星芒",
	"style": "风格",
	"armory": "军械库",
	"bathroom": "浴室",
	"bathtub": "浴缸",
	"bedroom": "卧室",
	"cafeteria": "食堂",
	"classroom": "教室",
	"closet": "衣帽间",
	"clubroom": "社团活动室",
	"conservatory": "温室",
	"courtroom": "法庭",
	"cubicle": "隔间工位",
	"dungeon": "地牢",
	"fitting": "试衣",
	"gym": "健身房",
	"storeroom": "储藏室",
	"kitchen": "厨房",
	"laboratory": "实验室",
	"library": "图书馆",
	"office": "办公室",
	"shower": "淋浴间",
	"stage": "舞台",
	"workshop": "工坊",
	"airfield": "机场跑道",
	"alley": "小巷",
	"amusement": "游乐",
	"park": "公园",
	"aqueduct": "高架水道",
	"bamboo": "竹林",
	"forest": "森林",
	"beach": "海滩",
	"bridge": "桥",
	"canal": "运河",
	"canyon": "峡谷",
	"carousel": "旋转木马",
	"cave": "洞穴",
	"city": "城市",
	"cliff": "悬崖",
	"crosswalk": "斑马线",
	"dam": "大坝",
	"desert": "沙漠",
	"dirt": "土路",
	"road": "道路",
	"dock": "码头",
	"drydock": "船坞",
	"field": "原野",
	"flower": "花",
	"garden": "花园",
	"geyser": "间歇泉",
	"glacier": "冰川",
	"graveyard": "墓地",
	"harbor": "港口",
	"highway": "公路",
	"hill": "山丘",
	"island": "岛屿",
	"jetty": "栈桥",
	"jungle": "丛林",
	"lake": "湖泊",
	"market": "集市",
	"meadow": "草地",
	"mountain": "山",
	"nature": "自然",
	"oasis": "绿洲",
	"ocean": "海洋",
	"bottom": "海底",
	"paper": "纸质",
	"lantern": "灯笼",
	"path": "小路",
	"riverside": "河畔",
	"street": "街道",
	"suburban": "郊区",
	"quiet": "安静",
	"pass": "山口",
	"peak": "山峰",
	"ski": "滑雪",
	"slope": "坡道",
	"music": "音乐",
	"festival": "节庆",
	"campground": "营地",
	"neighborhood": "社区",
	"woman": "女性",
	"man": "男性",
	"girl": "女孩",
	"boy": "男孩",
}


def _contains_cjk(text: Any) -> bool:
	return bool(re.search(r"[\u4e00-\u9fff]", _normalize_text(text)))


def _normalize_text(value: Any) -> str:
	return str(value or "").strip()


def _normalize_key(value: Any) -> str:
	return re.sub(r"[\s,，;；|/\\:_\-]+", "", _normalize_text(value).lower())


def _split_tokens(text: str) -> list[str]:
	return [_normalize_text(part) for part in re.split(r"[\n,，;；]+", str(text or "")) if _normalize_text(part)]


def _dedupe_keep_order(values: list[str]) -> list[str]:
	result: list[str] = []
	seen: set[str] = set()
	for value in values:
		clean = _normalize_text(value).strip(",")
		if not clean:
			continue
		key = _normalize_key(clean)
		if key and key in seen:
			continue
		if key:
			seen.add(key)
		result.append(clean)
	return result


def _join_segments(values: list[str]) -> str:
	return ", ".join(_dedupe_keep_order(values)).strip(", ")


def _extract_option_value(value: Any) -> str:
	text = _normalize_text(value)
	if OPTION_SEPARATOR in text:
		return _normalize_text(text.split(OPTION_SEPARATOR, 1)[1])
	return text


def _translate_numeric_subject(text: str) -> str:
	result = text
	patterns = [
		(r"(\d+)\s*girls?", r"\1个女孩"),
		(r"(\d+)\s*boys?", r"\1个男孩"),
		(r"(\d+)\s*women", r"\1个女人"),
		(r"(\d+)\s*men", r"\1个男人"),
	]
	for pattern, repl in patterns:
		result = re.sub(pattern, repl, result, flags=re.IGNORECASE)
	return result


def _translate_special_english_label(text: str) -> str:
	source = _normalize_text(text)
	if not source:
		return source

	lower = source.lower()
	if lower.startswith("style by "):
		return f"{source[9:]}风格"

	for suffix, cn_suffix in (
		(" analog", "胶片相机"),
		(" digital", "数码相机"),
		(" cinema", "电影机"),
	):
		if lower.endswith(suffix):
			return f"{source[:-len(suffix)]} {cn_suffix}"

	if any(brand in lower for brand in ("kodak", "agfa", "fuji", "fujifilm", "ilford", "cinestill", "ektar", "vision3")):
		if "胶片" not in source and "相机" not in source:
			return f"{source}胶片"

	return source


@lru_cache(maxsize=1)
def _load_label_translations() -> dict[str, str]:
	try:
		table = load_translation_table(str(LABEL_TRANSLATIONS_PATH))
	except Exception:
		table = None
	if table and table.en_to_zh:
		return {
			normalize_translation_text(key): normalize_translation_text(value)
			for key, value in table.en_to_zh.items()
			if normalize_translation_text(key) and normalize_translation_text(value)
		}

	if not LEGACY_LABEL_TRANSLATIONS_PATH.exists():
		return {}
	try:
		data = json.loads(LEGACY_LABEL_TRANSLATIONS_PATH.read_text(encoding="utf-8"))
	except Exception:
		return {}
	if not isinstance(data, dict):
		return {}
	return {
		_normalize_text(key): _normalize_text(value)
		for key, value in data.items()
		if _normalize_text(key) and _normalize_text(value)
	}


def _translate_from_cache(text: str) -> str:
	source = _normalize_text(text)
	if not source:
		return source
	cache = _load_label_translations()
	candidate = cache.get(source) or cache.get(source.lower())
	return _normalize_text(candidate)


def _translate_token_sequence(text: str) -> str:
	source = _normalize_text(text)
	if not source:
		return source

	parts = re.split(r"([\s_\-/,&()+]+)", source)
	translated_parts: list[str] = []
	translated_any = False

	for part in parts:
		token = _normalize_text(part)
		if not token:
			if re.fullmatch(r"[\s_]+", part):
				translated_parts.append("")
			elif re.fullmatch(r"[-/&]+", part):
				translated_parts.append("")
			else:
				translated_parts.append(part)
			continue

		if re.fullmatch(r"[A-Za-z']+", token):
			lookup = TOKEN_TRANSLATIONS.get(token.lower())
			if lookup is None:
				return source
			translated_parts.append(lookup)
			translated_any = translated_any or bool(lookup)
			continue

		translated_parts.append(part)

	result = "".join(translated_parts)
	result = re.sub(r"\s+", "", result).strip()
	return result if translated_any and result else source


def _english_to_cn_label(text: Any) -> str:
	source = _normalize_text(text)
	if not source or _contains_cjk(source):
		return source

	lower = source.lower()
	if lower in {"none", "random"}:
		return OPTION_NONE if lower == "none" else OPTION_RANDOM

	cached = _translate_from_cache(source)
	if _contains_cjk(cached):
		return cached

	special = _translate_special_english_label(source)
	if _contains_cjk(special):
		return special

	translated = _translate_numeric_subject(source)
	lower_translated = translated.lower()
	if lower_translated != lower:
		return translated

	for phrase, cn in sorted(PHRASE_TRANSLATIONS.items(), key=lambda item: len(item[0]), reverse=True):
		translated = re.sub(re.escape(phrase), cn, translated, flags=re.IGNORECASE)

	if _contains_cjk(translated):
		return translated

	result = _translate_token_sequence(source)
	return result if result != source else source


def _make_display_label(text: Any) -> str:
	source = _extract_option_value(text)
	if source in ("", OPTION_NONE, OPTION_RANDOM, OPTION_OFF, OPTION_ON):
		return source
	translated = _english_to_cn_label(source)
	if translated and translated != source:
		return f"{translated}{OPTION_SEPARATOR}{source}"
	return source


def _require_file(path: Path, label: str) -> Path:
	if not path.exists():
		raise RuntimeError(f"未找到 {label} 预设文件：{path}")
	return path


@lru_cache(maxsize=1)
def _load_json(path: str) -> Any:
	with open(path, "r", encoding="utf-8") as handle:
		return json.load(handle)


@lru_cache(maxsize=1)
def _load_styles_catalog() -> tuple[list[str], dict[str, dict[str, Any]]]:
	file_path = _require_file(PRESET_ROOT / "fooocus_styles.json", "风格")
	items = _load_json(str(file_path))
	options = [OPTION_NONE]
	lookup: dict[str, dict[str, Any]] = {}
	for item in items:
		if not isinstance(item, dict):
			continue
		name = _normalize_text(item.get("name"))
		if not name:
			continue
		name_cn = _normalize_text(item.get("name_cn"))
		label = f"{name_cn}｜{name}" if name_cn and name_cn != name else (name_cn or name)
		options.append(label)
		for alias in {label, name, name_cn}:
			alias_text = _normalize_text(alias)
			if alias_text:
				lookup[alias_text] = item
				lookup[_normalize_key(alias_text)] = item
	return options, lookup


def _build_style_thumbnail_url(item: dict[str, Any]) -> str:
	thumbnail = item.get("thumbnail")
	if isinstance(thumbnail, list):
		for candidate in thumbnail:
			text = _normalize_text(candidate)
			if text:
				return text
	elif isinstance(thumbnail, str):
		text = _normalize_text(thumbnail)
		if text:
			return text

	name = _normalize_text(item.get("name"))
	slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
	if not slug:
		return ""
	return f"https://raw.githubusercontent.com/lllyasviel/Fooocus/main/sdxl_styles/samples/{slug}.jpg"


@lru_cache(maxsize=1)
def load_prompt_preset_style_cards() -> list[dict[str, Any]]:
	file_path = _require_file(PRESET_ROOT / "fooocus_styles.json", "风格")
	items = _load_json(str(file_path))
	cards: list[dict[str, Any]] = []
	for item in items:
		if not isinstance(item, dict):
			continue
		name = _normalize_text(item.get("name"))
		if not name:
			continue
		name_cn = _normalize_text(item.get("name_cn"))
		label = f"{name_cn}{OPTION_SEPARATOR}{name}" if name_cn and name_cn != name else (name_cn or name)
		cards.append({
			"name": name,
			"name_cn": name_cn,
			"label": label,
			"thumbnail": _build_style_thumbnail_url(item),
			"prompt": _normalize_text(item.get("prompt")),
			"negative_prompt": _normalize_text(item.get("negative_prompt")),
		})
	return cards


@lru_cache(maxsize=1)
def _load_subject_catalog() -> dict[str, dict[str, str]]:
	file_path = _require_file(PRESET_ROOT / "subject.json", "主体")
	return _load_json(str(file_path))


@lru_cache(maxsize=1)
def _load_environment_catalog() -> dict[str, dict[str, str]]:
	file_path = _require_file(PRESET_ROOT / "environment.json", "环境")
	return _load_json(str(file_path))


@lru_cache(maxsize=1)
def _load_random_catalog() -> dict[str, list[str]]:
	root = _require_file(PRESET_ROOT / "rv_random", "随机灵感")
	data: dict[str, list[str]] = {}
	for field_name, filename, _display_name in RANDOM_SPECS:
		path = root / filename
		if not path.exists():
			data[field_name] = []
			continue
		lines = [_normalize_text(line) for line in path.read_text(encoding="utf-8").splitlines()]
		data[field_name] = [line for line in lines if line]
	return data


def _source_combo_options(mapping: dict[str, str]) -> list[str]:
	values: list[str] = []
	for key in mapping.keys():
		if key == "None":
			values.append(OPTION_NONE)
		elif key == "Random":
			values.append(OPTION_RANDOM)
		else:
			values.append(_make_display_label(key))
	return values or [OPTION_NONE]


def _resolve_source_choice(value: str, mapping: dict[str, str], rng: random.Random) -> str:
	choice = _extract_option_value(value)
	if choice in ("", OPTION_NONE, "None"):
		return ""
	if choice in (OPTION_RANDOM, "Random"):
		pool = [text for key, text in mapping.items() if key not in ("None", "Random") and _normalize_text(text)]
		return rng.choice(pool) if pool else ""
	return _normalize_text(mapping.get(choice, ""))


def _resolve_id_photo_choice(value: str, options: list[str], rng: random.Random) -> str:
	choice = _extract_option_value(value)
	if choice in ("", OPTION_NONE):
		return ""
	if choice == OPTION_RANDOM:
		pool = [item for item in options if item not in (OPTION_NONE, OPTION_RANDOM)]
		return rng.choice(pool) if pool else ""
	return choice


def _build_id_photo_prompt(kwargs: dict[str, Any], rng: random.Random) -> str:
	base_descs = []
	for field_name in ("证件照体型", "证件照国籍", "证件照性别"):
		value = _resolve_id_photo_choice(kwargs.get(field_name, OPTION_NONE), ID_PHOTO_OPTIONS[field_name], rng)
		if value:
			base_descs.append(value)

	prompt_parts: list[str] = []
	if base_descs:
		prompt_parts.append(f"一个{' '.join(base_descs)}")

	for field_name in ("证件照构图", "证件照服饰佩饰", "证件照表情", "证件照妆容", "证件照其他佩饰"):
		value = _resolve_id_photo_choice(kwargs.get(field_name, OPTION_NONE), ID_PHOTO_OPTIONS[field_name], rng)
		if value:
			prompt_parts.append(value)

	hair_color = _resolve_id_photo_choice(kwargs.get("证件照发色", OPTION_NONE), ID_PHOTO_OPTIONS["证件照发色"], rng)
	hair_style = _resolve_id_photo_choice(kwargs.get("证件照发型", OPTION_NONE), ID_PHOTO_OPTIONS["证件照发型"], rng)
	if hair_color or hair_style:
		prompt_parts.append(" ".join(part for part in (hair_color, hair_style) if part))

	clothing_color = _resolve_id_photo_choice(kwargs.get("证件照服装颜色", OPTION_NONE), ID_PHOTO_OPTIONS["证件照服装颜色"], rng)
	clothing_style = _resolve_id_photo_choice(kwargs.get("证件照服装款式", OPTION_NONE), ID_PHOTO_OPTIONS["证件照服装款式"], rng)
	if clothing_color or clothing_style:
		prompt_parts.append(" ".join(part for part in (clothing_color, clothing_style) if part))

	background = _resolve_id_photo_choice(kwargs.get("证件照背景色", OPTION_NONE), ID_PHOTO_OPTIONS["证件照背景色"], rng)
	if background:
		prompt_parts.append(background if "背景" in background else f"{background}背景")

	return _join_segments(prompt_parts)


def _build_multi_angle_prompt(rotate: int, vertical: int, zoom: float, detail_mode: str) -> str:
	rotate = max(0, min(360, int(rotate)))
	vertical = max(-90, min(90, int(vertical)))
	zoom = max(0.0, min(10.0, float(zoom)))
	h_angle = rotate % 360
	add_angle_prompt = _normalize_text(detail_mode) != "简洁"
	h_suffix = "" if add_angle_prompt else " quarter"

	if h_angle < 22.5 or h_angle >= 337.5:
		h_direction = "front view"
	elif h_angle < 67.5:
		h_direction = f"front-right{h_suffix} view"
	elif h_angle < 112.5:
		h_direction = "right side view"
	elif h_angle < 157.5:
		h_direction = f"back-right{h_suffix} view"
	elif h_angle < 202.5:
		h_direction = "back view"
	elif h_angle < 247.5:
		h_direction = f"back-left{h_suffix} view"
	elif h_angle < 292.5:
		h_direction = "left side view"
	else:
		h_direction = f"front-left{h_suffix} view"

	if add_angle_prompt:
		if vertical == -90:
			v_direction = "bottom-looking-up perspective, extreme worm's eye view, focus subject bottom"
		elif vertical < -75:
			v_direction = "bottom-looking-up perspective, extreme worm's eye view"
		elif vertical < -45:
			v_direction = "ultra-low angle"
		elif vertical < -15:
			v_direction = "low angle"
		elif vertical < 15:
			v_direction = "eye level"
		elif vertical < 45:
			v_direction = "high angle"
		elif vertical < 75:
			v_direction = "bird's eye view"
		elif vertical < 90:
			v_direction = "top-down perspective, looking straight down at the top of the subject"
		else:
			v_direction = "top-down perspective, looking straight down at the top of the subject, face not visible, focus on subject head"
	else:
		if vertical < -15:
			v_direction = "low-angle shot"
		elif vertical < 15:
			v_direction = "eye-level shot"
		elif vertical < 45:
			v_direction = "elevated shot"
		elif vertical < 75:
			v_direction = "high-angle shot"
		else:
			v_direction = "top-down shot"

	if zoom < 2:
		distance = "extreme wide shot"
	elif zoom < 4:
		distance = "wide shot"
	elif zoom < 6:
		distance = "medium shot"
	elif zoom < 8:
		distance = "close-up"
	else:
		distance = "extreme close-up"

	if add_angle_prompt:
		return f"{h_direction}, {v_direction}, {distance} (horizontal: {rotate}, vertical: {vertical}, zoom: {zoom:.1f})"
	return f"{h_direction} {v_direction} {distance}"


def _collect_style_items(primary_style: str, extra_style_list: str) -> list[dict[str, Any]]:
	_options, lookup = _load_styles_catalog()
	items: list[dict[str, Any]] = []
	for token in [primary_style, *_split_tokens(extra_style_list)]:
		resolved_token = _extract_option_value(token)
		candidate = lookup.get(_normalize_text(token)) or lookup.get(_normalize_key(token)) or lookup.get(_normalize_text(resolved_token)) or lookup.get(_normalize_key(resolved_token))
		if isinstance(candidate, dict):
			items.append(candidate)
	return items


def _apply_style_mix(core_positive: str, base_negative: str, style_items: list[dict[str, Any]]) -> tuple[str, str]:
	if not style_items:
		return core_positive, base_negative

	positive_prompt = core_positive
	negative_parts = [base_negative] if _normalize_text(base_negative) else []
	has_prompt = False

	for item in style_items:
		prompt_text = _normalize_text(item.get("prompt"))
		negative_text = _normalize_text(item.get("negative_prompt"))
		if prompt_text:
			if "{prompt}" in prompt_text and not has_prompt:
				positive_prompt = prompt_text.replace("{prompt}", positive_prompt)
				has_prompt = True
			elif "{prompt}" in prompt_text:
				positive_prompt = _join_segments([
					positive_prompt,
					prompt_text.replace(", {prompt}", "").replace("{prompt}", ""),
				])
			else:
				positive_prompt = _join_segments([positive_prompt, prompt_text])
		if negative_text:
			negative_parts.append(negative_text)

	return positive_prompt.strip(", "), _join_segments(negative_parts)


async def get_prompt_preset_styles_api(request):
	return web.json_response({"styles": load_prompt_preset_style_cards()})


def _build_prompt_preset_defaults() -> dict[str, Any]:
	defaults: dict[str, Any] = {
		"风格模式": OPTION_OFF,
		"主风格": OPTION_NONE,
		"附加风格列表": "",
		"证件照模式": OPTION_OFF,
		"多角度模式": OPTION_OFF,
		"视角旋转": 0,
		"视角俯仰": 0,
		"镜头远近": 5.0,
		"视角描述": "详细",
		"主体模式": OPTION_OFF,
		"环境模式": OPTION_OFF,
		"随机灵感模式": OPTION_OFF,
	}

	for field_name, options in ID_PHOTO_OPTIONS.items():
		defaults[field_name] = options[0] if options else OPTION_NONE

	for internal_name, _source_key, _display_name, _tooltip in SUBJECT_SPECS:
		defaults[internal_name] = OPTION_NONE

	for internal_name, _source_key, _display_name, _tooltip in ENVIRONMENT_SPECS:
		defaults[internal_name] = OPTION_NONE

	for field_name, _filename, _display_name in RANDOM_SPECS:
		defaults[field_name] = OPTION_OFF

	return defaults


def _build_prompt_preset_schema() -> dict[str, Any]:
	subject_catalog = _load_subject_catalog()
	environment_catalog = _load_environment_catalog()
	random_catalog = _load_random_catalog()

	fields: dict[str, Any] = {
		"视角旋转": {
			"kind": "int",
			"display_name": "视角旋转",
			"tooltip": "水平旋转角度，0 为正面，90 为右侧，180 为背面。",
			"default": 0,
			"min": 0,
			"max": 360,
			"step": 1,
		},
		"视角俯仰": {
			"kind": "int",
			"display_name": "视角俯仰",
			"tooltip": "垂直俯仰角度，负值更仰拍，正值更俯拍。",
			"default": 0,
			"min": -90,
			"max": 90,
			"step": 1,
		},
		"镜头远近": {
			"kind": "float",
			"display_name": "镜头远近",
			"tooltip": "0 更远景，10 更特写。",
			"default": 5.0,
			"min": 0.0,
			"max": 10.0,
			"step": 0.1,
		},
		"视角描述": {
			"kind": "select",
			"display_name": "视角描述",
			"tooltip": "详细会带角度和 zoom 数值，简洁则更像普通镜头描述。",
			"default": "详细",
			"options": DETAIL_MODE_OPTIONS,
		},
	}

	for field_name, options in ID_PHOTO_OPTIONS.items():
		fields[field_name] = {
			"kind": "select",
			"display_name": field_name,
			"tooltip": f"{field_name}的预设选项；证件照模式关闭时会自动忽略。",
			"default": options[0] if options else OPTION_NONE,
			"options": options,
		}

	for internal_name, source_key, display_name, tooltip in SUBJECT_SPECS:
		fields[internal_name] = {
			"kind": "select",
			"display_name": display_name,
			"tooltip": f"{tooltip} 主体模式关闭时会自动忽略。",
			"default": OPTION_NONE,
			"options": _source_combo_options(subject_catalog.get(source_key, {"None": ""})),
		}

	for internal_name, source_key, display_name, tooltip in ENVIRONMENT_SPECS:
		fields[internal_name] = {
			"kind": "select",
			"display_name": display_name,
			"tooltip": f"{tooltip} 环境模式关闭时会自动忽略。",
			"default": OPTION_NONE,
			"options": _source_combo_options(environment_catalog.get(source_key, {"None": ""})),
		}

	for field_name, _filename, display_name in RANDOM_SPECS:
		fields[field_name] = {
			"kind": "select",
			"display_name": display_name,
			"tooltip": f"{display_name}；可关闭、固定手选，或让节点按随机种子抽取。",
			"default": OPTION_OFF,
			"options": [OPTION_OFF, OPTION_RANDOM, *[_make_display_label(item) for item in random_catalog.get(field_name, [])]],
		}

	return {
		"defaults": _build_prompt_preset_defaults(),
		"sections": [
			{
				"key": "style",
				"label": "风格",
				"mode_key": "风格模式",
				"mode_options": STYLE_MODE_OPTIONS,
				"fields": ["主风格", "附加风格列表"],
			},
			{
				"key": "idPhoto",
				"label": "证件照",
				"mode_key": "证件照模式",
				"mode_options": [OPTION_OFF, OPTION_ON],
				"fields": ID_PHOTO_FIELDS,
			},
			{
				"key": "angle",
				"label": "多角度",
				"mode_key": "多角度模式",
				"mode_options": [OPTION_OFF, OPTION_ON],
				"fields": ANGLE_FIELDS,
			},
			{
				"key": "subject",
				"label": "主体",
				"mode_key": "主体模式",
				"mode_options": [OPTION_OFF, OPTION_ON],
				"fields": SUBJECT_FIELDS,
			},
			{
				"key": "environment",
				"label": "环境",
				"mode_key": "环境模式",
				"mode_options": [OPTION_OFF, OPTION_ON],
				"fields": ENVIRONMENT_FIELDS,
			},
			{
				"key": "random",
				"label": "随机灵感",
				"mode_key": "随机灵感模式",
				"mode_options": [OPTION_OFF, OPTION_ON],
				"fields": RANDOM_FIELDS,
			},
		],
		"fields": fields,
	}


def _parse_prompt_preset_config(raw_value: Any) -> dict[str, Any]:
	defaults = _build_prompt_preset_defaults()
	if raw_value in (None, "", "{}"):
		return dict(defaults)

	try:
		parsed = json.loads(str(raw_value))
	except Exception:
		return dict(defaults)

	if not isinstance(parsed, dict):
		return dict(defaults)

	merged = dict(defaults)
	for key, value in parsed.items():
		if key in merged:
			merged[key] = value
	return merged


def _merge_prompt_preset_config_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
	merged = _parse_prompt_preset_config(kwargs.get(CONFIG_STORE_WIDGET))
	for key, value in kwargs.items():
		if key == CONFIG_STORE_WIDGET:
			continue
		merged[key] = value
	return merged


async def get_prompt_preset_schema_api(request):
	return web.json_response(_build_prompt_preset_schema())


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
	PromptServer.instance.routes.get(PROMPT_PRESET_STYLES_API_PATH)(get_prompt_preset_styles_api)
	PromptServer.instance.routes.get(PROMPT_PRESET_SCHEMA_API_PATH)(get_prompt_preset_schema_api)


class GJJ_PromptPresetStudio:
	CATEGORY = "GJJ"
	FUNCTION = "build"
	DESCRIPTION = "把风格、证件照、主体、环境、随机灵感与多角度提示词整合到一个 GJJ 零依赖节点中，直接输出混合正负提示词。"
	SEARCH_ALIASES = ["提示词预设", "风格", "证件照", "主体", "环境", "随机提示词", "fooocus", "rvtools"]
	RETURN_TYPES = ("STRING", "STRING")
	RETURN_NAMES = ("混合正向提示词", "混合反向提示词")
	OUTPUT_TOOLTIPS = ("已按当前启用分组混合后的正向提示词。", "已按当前启用分组混合后的反向提示词。")

	@classmethod
	def INPUT_TYPES(cls):
		return {
			"required": {
			"正向基础词": ("STRING", {
				"default": "",
				"multiline": False,
				"display_name": "正向基础词",
				"tooltip": "手动填写的基础正向提示词，会在所有预设片段之前参与混合。",
			}),
			"反向基础词": ("STRING", {
				"default": "",
				"multiline": False,
				"display_name": "反向基础词",
				"tooltip": "手动填写的基础反向提示词，会与风格反向和通用反向一起混合。",
			}),
			"通用反向预设": (NEGATIVE_PRESET_OPTIONS, {
				"default": "通用写实",
				"display_name": "通用反向预设",
				"tooltip": "按用途补一组常见反向词；选关闭则只保留你自己的反向词和风格反向。",
			}),
			"随机种子": ("INT", {
				"default": 0,
				"min": 0,
				"max": 0xffffffffffffffff,
				"control_after_generate": True,
				"display_name": "随机种子",
				"tooltip": "当任一项选择随机时生效。填 0 表示每次重新抽取，其他值可固定结果。",
			}),
			CONFIG_STORE_WIDGET: ("STRING", {
				"default": "{}",
				"multiline": False,
				"display_name": "配置存储",
				"tooltip": "内部使用的动态面板配置 JSON。",
			}),
			},
		}

	@classmethod
	def IS_CHANGED(cls, **kwargs):
		merged_kwargs = _merge_prompt_preset_config_kwargs(kwargs)
		random_widgets = []
		for key, value in merged_kwargs.items():
			text = _normalize_text(value)
			if key == "随机种子":
				continue
			if text in (OPTION_RANDOM, "Random"):
				random_widgets.append(key)
		if random_widgets and int(merged_kwargs.get("随机种子", 0) or 0) == 0:
			return float("NaN")
		return "|".join(f"{key}={merged_kwargs.get(key)}" for key in sorted(merged_kwargs.keys()))

	def build(self, positive_input="", negative_input="", **kwargs):
		kwargs = _merge_prompt_preset_config_kwargs(kwargs)
		seed_value = int(kwargs.get("随机种子", 0) or 0)
		rng = random.Random(seed_value if seed_value > 0 else (time.time_ns() & 0xFFFFFFFF))

		positive_segments = [
			_normalize_text(positive_input),
			_normalize_text(kwargs.get("正向基础词", "")),
		]
		negative_segments = [
			_normalize_text(negative_input),
			_normalize_text(kwargs.get("反向基础词", "")),
			_normalize_text(NEGATIVE_PRESETS.get(_normalize_text(kwargs.get("通用反向预设", "关闭")), "")),
		]

		if _normalize_text(kwargs.get("证件照模式", OPTION_OFF)) == OPTION_ON:
			positive_segments.append(_build_id_photo_prompt(kwargs, rng))

		if _normalize_text(kwargs.get("多角度模式", OPTION_OFF)) == OPTION_ON:
			positive_segments.append(_build_multi_angle_prompt(
				rotate=int(kwargs.get("视角旋转", 0) or 0),
				vertical=int(kwargs.get("视角俯仰", 0) or 0),
				zoom=float(kwargs.get("镜头远近", 5.0) or 5.0),
				detail_mode=_normalize_text(kwargs.get("视角描述", "详细")),
			))

		if _normalize_text(kwargs.get("主体模式", OPTION_OFF)) == OPTION_ON:
			subject_catalog = _load_subject_catalog()
			for internal_name, source_key, _display_name, _tooltip in SUBJECT_SPECS:
				positive_segments.append(_resolve_source_choice(kwargs.get(internal_name, OPTION_NONE), subject_catalog.get(source_key, {}), rng))

		if _normalize_text(kwargs.get("环境模式", OPTION_OFF)) == OPTION_ON:
			environment_catalog = _load_environment_catalog()
			for internal_name, source_key, _display_name, _tooltip in ENVIRONMENT_SPECS:
				positive_segments.append(_resolve_source_choice(kwargs.get(internal_name, OPTION_NONE), environment_catalog.get(source_key, {}), rng))

		if _normalize_text(kwargs.get("随机灵感模式", OPTION_OFF)) == OPTION_ON:
			random_catalog = _load_random_catalog()
			for field_name, _filename, _display_name in RANDOM_SPECS:
				value = _extract_option_value(kwargs.get(field_name, OPTION_OFF))
				if value in ("", OPTION_OFF, "disabled"):
					continue
				if value == OPTION_RANDOM:
					choices = random_catalog.get(field_name, [])
					if choices:
						positive_segments.append(rng.choice(choices))
				else:
					positive_segments.append(value)

		core_positive = _join_segments(positive_segments)
		core_negative = _join_segments(negative_segments)

		style_mode = _normalize_text(kwargs.get("风格模式", OPTION_OFF))
		style_items: list[dict[str, Any]] = []
		if style_mode == "单风格":
			style_items = _collect_style_items(kwargs.get("主风格", OPTION_NONE), "")
		elif style_mode == "多风格":
			style_items = _collect_style_items(kwargs.get("主风格", OPTION_NONE), kwargs.get("附加风格列表", ""))

		final_positive, final_negative = _apply_style_mix(core_positive, core_negative, style_items)
		final_positive = _join_segments([final_positive])
		final_negative = _join_segments([final_negative])

		return {
			"ui": {
				"text": (f"正向：{final_positive}\n\n反向：{final_negative}",),
			},
			"result": (final_positive, final_negative),
		}


NODE_CLASS_MAPPINGS = {
	NODE_NAME: GJJ_PromptPresetStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
	NODE_NAME: "GJJ · 🧰 多功能提示词预设",
}

from __future__ import annotations

import re
from typing import Any


NODE_NAME = "GJJ_PromptTemplateSelector"


class GJJ_PROMPT(str):
    """Prompt template text for GJJ_TemplatePrompt external template input."""


DEFAULT_TEMPLATE_LIBRARY = """《清新家电横版商品广告》这是一张{{产品类型(加湿器)}}横版商品广告图，整体采用{{配色(白色、浅木色和清新绿色)}}配色，背景是{{背景场景(阳光充足的客厅或书房)}}，窗外和室内植物虚化成柔和光斑。桌面上摆放一台{{产品外观(白色圆柱形加湿器)}}，{{产品动态(顶部持续喷出白色细雾)}}。左侧主标题以大号{{标题字体颜色(深绿色粗体字)}}写着“{{主标题第一行(清新加湿，)}}”“{{主标题第二行(舒适每一天)}}”，副标题写着“{{副标题(为家注入清润空气，呵护全家健康呼吸)}}”，下方有细横线分隔。再下方四组图标与卖点文字依次为“{{卖点1标题(大容量补水)}}”“{{卖点1说明(持久加湿，无需频繁加水)}}”，“{{卖点2标题(静音运行)}}”“{{卖点2说明(低噪设计，安静不打扰)}}”，“{{卖点3标题(细腻雾化)}}”“{{卖点3说明(均匀细腻水雾，润泽每一寸空气)}}”，“{{卖点4标题(一键操作)}}”“{{卖点4说明(简单便捷，老人也能轻松使用)}}”。右侧产品机身正面印有品牌字样“{{品牌(Gezier)}}”，保留透明水位窗、电源按键和状态指示灯等细节。桌面旁边有{{辅助道具(透明玻璃杯、植物盆栽、白色书本和浅色器皿)}}。整体构图为左文右图，环境干净通透，强调{{核心属性(大容量补水、静音、细雾加湿和简单操作)}}的家用属性。
《个人彩妆诊断图卡》标题为“{{主标题(个人彩妆诊断图卡)}}”，带字幕“{{副标题(打造专属你的氛围感妆容)}}”。制作一张粉白色背景的平直设计信息图，顶部三列结构。左列标题为“{{左列标题(建议保留)}}”，展示6排{{保留产品类型(化妆产品照片)}}，每张照片有粉红色勾号、黑体标题和说明，内容依次为：{{保留清单(蜜桃色腮红：提气色神器，日常通勤必备；丝绒唇泥：高级哑光妆效，显白不挑皮；棕色眼线液笔：温柔自然，放大双眼；香槟色高光：点亮面部立体感；灰棕色眉笔：野生眉必备，自然持久；定妆喷雾：持妆一整天，水润不拔干)}}。中心柱放置{{人物主体(穿粉红色连衣裙、微笑的东亚女人)}}的大肖像，上方有粉红色标签分析框，写“{{分析标签(妆容风格：温婉千金；眼妆重点：奶茶色修容；面部氛围：柔和干净)}}”，并展示{{颜色样本(桃、玫瑰、灰褐色、可可色)}}色卡。右列上半部分标题为“{{右上标题(可闲置/可替换)}}”，列出{{替换清单(冷调芭比粉-显黑；蓝色珠光眼影-难驾驭；夸张假睫毛-妆感重；偏黄修容粉-易显脏)}}；右列下半部分标题为“{{右下标题(比较缺，建议补齐)}}”，用2x3栅格展示{{补齐清单(清透粉底液、腮红膏、大地色眼影盘、镜面唇釉、极细睫毛膏、散粉刷)}}。底部左侧显示“{{升级标题(妆容升级方向)}}”，包含3个look formula面板：{{升级方案(公式1：温柔通勤妆；公式2：元气约会妆；公式3：伪素颜白开水妆)}}。底部右侧显示“{{优先级标题(购买优先级)}}”，配粉红色化妆包图标和编号优先顺序：{{购买优先级(第一：底妆；第二：彩妆；第三：彩妆不在于多，而在于精)}}。整体清理、柔和、精致。
《发型分析信息图》标题为“{{主标题(发型分析/寻找最佳发型)}}”的信息图表海报，背景为{{背景色(灯光米色)}}。左上角是一张巨大的垂直照片，照片上是{{人物主体(年轻亚洲女性，穿浅蓝色丝绸衬衫，温柔微笑)}}。照片右侧有四个带图标和文本的属性：“{{属性1标题(面形状)}}”配“{{属性1内容(椭圆形)}}”，“{{属性2标题(头发纹理)}}”配“{{属性2内容(精细、轻微波纹)}}”，“{{属性3标题(头发体积)}}”配“{{属性3内容(中等)}}”，“{{属性4标题(关键点)}}”配“{{属性4内容(修饰颧骨)}}”。右上角是“{{最佳区域标题(最佳匹配)}}”部分，有2x3照片栅格，标记01-06，展示{{最佳发型(锁骨长发配窗帘刘海；下巴长内扣鲍勃；分层中长发配轻盈刘海；低凌乱发髻；侧分中长波浪；高马尾配柔软波纹)}}。中间是“{{备选区域标题(不错的选项)}}”，1x4照片栅格，标记07-10，展示{{备选发型(长直发钝刘海；半扎松散波纹；短精灵发；经典法国辫)}}。左下角是“{{不推荐标题(不推荐)}}”，1x3照片栅格，标记11-13，展示{{不推荐发型(厚重刘海遮眉；贴头皮中分直发；非常紧密的卷发)}}。右下角包含带复选标记的“{{提示标题(头发提示)}}”块，写{{提示内容(避免厚重造型产品；用圆梳在根部打造自然体积；每6-8周定期修剪)}}。整体是清理的界面设计风格。"""

TEMPLATE_HEADER_RE = re.compile(r"^《([^》\r\n]+)》", re.MULTILINE)


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def clean_body(lines: list[str]) -> str:
    while lines and not str(lines[0]).strip():
        lines.pop(0)
    while lines and not str(lines[-1]).strip():
        lines.pop()
    return "\n".join(lines).strip()


def parse_template_library(template_library: Any) -> list[dict[str, str]]:
    source = normalize_text(template_library) or DEFAULT_TEMPLATE_LIBRARY
    entries: list[dict[str, str]] = []
    matches = list(TEMPLATE_HEADER_RE.finditer(source))
    for index, match in enumerate(matches):
        next_match = matches[index + 1] if index + 1 < len(matches) else None
        title = match.group(1).strip()
        body_start = match.end()
        body_end = next_match.start() if next_match else len(source)
        body = clean_body(source[body_start:body_end].split("\n"))
        entries.append({"title": title, "body": body})
    return [entry for entry in entries if entry["title"] and entry["body"]]


def selected_template_body(template_library: Any, selected_template: Any) -> tuple[str, str]:
    entries = parse_template_library(template_library)
    if not entries:
        return "", ""
    selected = normalize_text(selected_template)
    for entry in entries:
        if entry["title"] == selected:
            return entry["title"], entry["body"]
    first = entries[0]
    return first["title"], first["body"]


class GJJ_PromptTemplateSelector:
    CATEGORY = "GJJ/提示词"
    FUNCTION = "select_template"
    RETURN_TYPES = ("GJJ_PROMPT",)
    RETURN_NAMES = ("模板正文",)
    OUTPUT_TOOLTIPS = ("当前按钮选中的模板正文，可直接连接到 GJJ_TemplatePrompt 的外接模板输入。",)
    DESCRIPTION = "模板动态选择节点。点击 ⚙️设置 填写模板库；模板库使用行首《模板名称》模板正文 的格式。"
    SEARCH_ALIASES = ["template selector", "prompt template selector", "模板动态选择", "模板选择", "GJJ_PROMPT"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template_library": (
                    "STRING",
                    {
                        "default": DEFAULT_TEMPLATE_LIBRARY,
                        "multiline": True,
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "模板库",
                        "tooltip": "点击前端 ⚙️设置 编辑。格式：每个模板用行首《模板名称》开始；下一个行首《模板名称》之前都属于当前模板。",
                    },
                ),
                "selected_template": (
                    "STRING",
                    {
                        "default": "",
                        "hidden": True,
                        "display": "hidden",
                        "display_name": "当前模板",
                        "tooltip": "当前选中的模板按钮标题，由前端按钮维护。",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, template_library: str = "", selected_template: str = ""):
        return f"{normalize_text(template_library)}\n---\n{normalize_text(selected_template)}"

    def select_template(self, template_library: str = "", selected_template: str = ""):
        title, body = selected_template_body(template_library, selected_template)
        return {
            "ui": {
                "selected_template": (title,),
                "template_body": (body,),
            },
            "result": (GJJ_PROMPT(body),),
        }


NODE_CLASS_MAPPINGS = {NODE_NAME: GJJ_PromptTemplateSelector}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "GJJ · 🧩 模板动态选择"}

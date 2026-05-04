const TEXT_MAP = new Map(Object.entries({
	"Explore": "浏览",
	"Create": "创建",
	"Retarget": "重定向",
	"Support": "支持",
	"Github": "源码",
	"Contributors": "贡献者",
	"Save Image to ComfyUI": "保存图片到 ComfyUI",
	"Save to ComfyUI": "保存到 ComfyUI",
	"Cancel": "取消",
	"Close": "关闭",
	"Upload": "上传",
	"or": "或",
	"Reference model": "参考模型",
	"Load": "加载",
	"Load Model": "加载模型",
	"Load Skeleton": "加载骨骼",
	"Debug": "调试",
	"Rotate": "旋转",
	"Pan": "平移",
	"Zoom": "缩放",
	"Rotate Model to face front": "将模型旋转到正面",
	"(blue origin line)": "（蓝色原点线）",
	"If model is below the ground floor": "如果模型低于地面",
	"Move": "移动",
	"Skeleton": "骨骼",
	"Skeleton template": "骨骼模板",
	"Skeleton template:": "骨骼模板：",
	"Select a skeleton": "选择骨骼",
	"Position Joints": "定位关节",
	"Test Skinning Algorithm": "测试蒙皮算法",
	"Test animations": "测试动画",
	"Pick a 3d animation to generate previews": "选择一个 3D 动画以生成预览",
	"Preparing": "准备中",
	"Recording video…": "录制视频中…",
	"Finish": "完成",
	"Human": "人形",
	"Fox": "狐狸",
	"Bird": "鸟类",
	"Dragon": "龙",
	"4 Leg Creature": "四足生物",
	"Cube": "立方体",
	"Sphere": "球体",
	"Capsule": "胶囊体",
	"Cylinder": "圆柱体",
	"Torus": "圆环体",
	"Cone": "圆锥体",
	"Kaiju": "怪兽",
	"Spider": "蜘蛛",
	"Snake": "蛇",
	"Quadruped (Fox)": "四足（狐狸）",
	"Hand Options": "手部选项",
	"All Fingers": "全部手指",
	"Thumb + Main Finger": "拇指 + 主手指",
	"All Fingers - Simplified": "全部手指（简化）",
	"Single Hand Bone": "单一手骨",
	"Scale skeleton": "缩放骨骼",
	"Back": "返回",
	"Edit Skeleton": "编辑骨骼",
	"Selected Bone:": "选中骨骼：",
	"None": "无",
	"Preview": "预览",
	"Transform": "变换",
	"Space": "坐标空间",
	"Mirror Left/Right Joints": "镜像左右关节",
	"Use Head Weight Correction": "使用头部权重修正",
	"Height:": "高度：",
	"Width:": "宽度：",
	"Skinning algorithm:": "蒙皮算法：",
	"Closest Distance Targeting": "最近距离目标",
	"Closest Bone": "最近骨骼",
	"Closest Distance Child": "最近距离子骨骼",
	"Bind pose": "绑定姿势",
	"Loading animation data": "正在加载动画数据",
	"A-Pose Correction - Open Arms": "A-Pose 修正 - 展开手臂",
	"Download": "下载",
	"No animation selected": "未选择动画",
	"Animations": "动画",
	"Camera Presets": "相机预设",
	"Camera presets": "相机预设",
	"Camera Tuning": "相机调节",
	"Camera tuning": "相机调节",
	"Preset": "预设",
	"Duration": "时长",
	"Lens": "镜头",
	"Free": "自由",
	"Basic Moves": "基础运镜",
	"BASIC MOVES": "基础运镜",
	"Cinematic": "电影运镜",
	"CINEMATIC": "电影运镜",
	"Handheld": "手持运镜",
	"HANDHELD": "手持运镜",
	"Speed Ramps": "速度变速",
	"SPEED RAMPS": "速度变速",
	"Locomotion": "移动跟拍",
	"LOCOMOTION": "移动跟拍",
	"Vehicle": "载具运镜",
	"VEHICLE": "载具运镜",
	"Action": "动作运镜",
	"ACTION": "动作运镜",
	"Abstract": "抽象运镜",
	"ABSTRACT": "抽象运镜",
	"180 Degree Pan": "180度环绕",
	"90 Degree Pan": "90度环绕",
	"Fast Pull": "快速拉远",
	"Fast Push": "快速推进",
	"Fast Zoom": "快速变焦",
	"Long Pull": "长距离拉远",
	"Long Push": "长距离推进",
	"Medium Pull": "中距离拉远",
	"Medium Push": "中距离推进",
	"Pan Down": "向下摇摄",
	"Pan Left": "向左摇摄",
	"Pan Right": "向右摇摄",
	"Pan Up": "向上摇摄",
	"Scenic Pan Left": "风景左摇",
	"Scenic Pan Right": "风景右摇",
	"Slide Down": "向下滑动",
	"Slide Left": "向左滑动",
	"Slide Right": "向右滑动",
	"Slide Up": "向上滑动",
	"Slow Pull": "慢速拉远",
	"Slow Push": "慢速推进",
	"Slow Zoom": "慢速变焦",
	"360 Pan and Tilt": "360度摇摄俯仰",
	"360 Track": "360度跟拍",
	"Bird's Eye Twist": "鸟瞰旋转",
	"Contra-Zoom": "希区柯克变焦",
	"Contra-Zoom 2": "希区柯克变焦 2",
	"Crane Side": "侧向摇臂",
	"Crane Sweep": "摇臂扫过",
	"Dolly": "轨道车",
	"J Move Down": "J形下移",
	"J Move Up": "J形上移",
	"L Move Down": "L形下移",
	"L Move Up": "L形上移",
	"Pan Back and Flip": "后摇并翻转",
	"Pull Rise": "拉远上升",
	"Pull to Bird's Eye": "拉远到鸟瞰",
	"Push Forward Pan Down": "前推下摇",
	"Push Forward Pan Up": "前推上摇",
	"Push Sink": "推进下沉",
	"Push to Ground": "推进到地面",
	"Push to Sky": "推进到天空",
	"Reverse Dolly": "反向轨道",
	"Sinister Zoom Twist In": "压迫旋入变焦",
	"Sinister Zoom Twist Out": "压迫旋出变焦",
	"Spiral Down": "螺旋下降",
	"Spiral Up": "螺旋上升",
	"Track Back Pan Down": "后退跟拍下摇",
	"Track Back Pan Up": "后退跟拍上摇",
	"Twist Pull": "旋转拉远",
	"Twist Push": "旋转推进",
	"Twist Zoom": "旋转变焦",
	"Under to Above": "由下到上",
	"Zoom In Pan Left": "放大左摇",
	"Zoom In Pan Right": "放大右摇",
	"Zoom Out Pan Down": "缩小下摇",
	"Zoom Out Pan Up": "缩小上摇",
	"Handheld Static": "手持静止",
	"Handheld Transition Left": "手持左转场",
	"Handheld Transition Right": "手持右转场",
	"Handheld Zoom In": "手持放大",
	"Handheld Zoom Out": "手持缩小",
	"Look Around": "环顾四周",
	"Pan Back and Flip Handheld": "手持后摇翻转",
	"Pan Left Handheld": "手持左摇",
	"Pan Right Handheld": "手持右摇",
	"Pull Handheld": "手持拉远",
	"Push Handheld": "手持推进",
	"Static Handheld Subtle": "轻微手持静止",
	"Turn, Look Up": "转身仰视",
	"180 Spin (CCW)": "180度逆时针旋转",
	"180 Spin (CW)": "180度顺时针旋转",
	"Crane Down": "摇臂下降",
	"Crane Up": "摇臂上升",
	"Move Down": "向下移动",
	"Move Left": "向左移动",
	"Move Right": "向右移动",
	"Move Up": "向上移动",
	"Pull Back": "后拉",
	"Pull Pan Down": "拉远下摇",
	"Pull Pan Up": "拉远上摇",
	"Push Down": "向下推进",
	"Push In": "推进",
	"Push Pan Down": "推进下摇",
	"Push Pan Up": "推进上摇",
	"Twist In": "旋入",
	"Twist Out": "旋出",
	"Running Backwards": "后退跑",
	"Running Forwards": "向前跑",
	"Running Sideways": "侧向跑",
	"Walking": "行走",
	"Fast Car Flyby L to R": "车辆快速掠过 左到右",
	"Fast Car Flyby R to L": "车辆快速掠过 右到左",
	"Flyover Zoom": "飞越变焦",
	"Helicopter Flyover 1": "直升机飞越 1",
	"Helicopter Flyover 2": "直升机飞越 2",
	"Jet Overpass 1": "喷气机掠过 1",
	"Jet Overpass 2": "喷气机掠过 2",
	"Mini Spy Drone": "小型侦察机",
	"Slow Flyover": "慢速飞越",
	"Traffic Weaving": "车流穿梭",
	"Automatic Gun Fire": "自动火力",
	"Base Jump": "定点跳伞",
	"Bleeding Out": "失血倒下",
	"Curved Missile Strike": "弧线导弹打击",
	"Explosion": "爆炸",
	"Fall Backwards": "向后倒下",
	"Flinch": "退缩",
	"Missile Strike": "导弹打击",
	"Drunk": "醉酒",
	"Space Cam Float 2": "太空漂浮镜头 2",
	"Space Cam Float 3": "太空漂浮镜头 3",
	"Space Camera Floating": "太空漂浮镜头",
	"Spinning in Space": "太空旋转",
	"Filter animations...": "筛选动画...",
	"Pick a camera preset to enable tuning.": "请选择相机预设后再调节。",
	"Speed": "速度",
	"FOV Scale": "视角缩放",
	"Path Scale": "路径缩放",
	"Yaw": "偏航",
	"Offset (XYZ)": "位置偏移 (XYZ)",
	"Reverse": "反向",
	"Loop": "循环",
	"Play / Pause": "播放 / 暂停",
	"Loop playback (timeline)": "循环播放（时间轴）",
	"Loop model animation": "循环模型动画",
	"Timeline zoom": "时间轴缩放",
	"paused": "已暂停",
	"Dark": "深色",
	"Light": "浅色",
	"Angry": "愤怒",
	"Attack": "攻击",
	"Backflip": "后空翻",
	"Bark": "吠叫",
	"Bite": "咬击",
	"Bow": "鞠躬",
	"Chest_Open": "开宝箱",
	"ClimbUp_1m_RM": "攀爬1米 RM",
	"Coiled": "盘绕",
	"Confused": "困惑",
	"Consume": "吃喝",
	"Consume Item": "使用物品",
	"Crawl": "爬行",
	"Crawl RM": "爬行 RM",
	"Crouch_Fwd_Loop": "蹲伏前进循环",
	"Crouch_Idle_Loop": "蹲伏待机循环",
	"Dance": "舞蹈",
	"Dance Body Roll": "身体波浪舞",
	"Dance Charleston": "查尔斯顿舞",
	"Dance Reach Hip": "摆胯舞",
	"Dance_Loop": "舞蹈循环",
	"Death": "倒地",
	"Death 2": "倒地 2",
	"Death01": "倒地 01",
	"Defend": "防御",
	"Dizzy": "眩晕",
	"Driving_Loop": "驾驶循环",
	"Eating": "进食",
	"Fall": "跌倒",
	"Farm_Harvest": "收割",
	"Farm_PlantSeed": "播种",
	"Farm_Watering": "浇水",
	"Fetch": "取物",
	"Fighting Idle": "战斗待机",
	"Fighting Left Jab": "左刺拳",
	"Fighting Right Jab": "右刺拳",
	"Fixing_Kneeling": "跪姿修理",
	"Flap": "拍翼",
	"Fly Flap": "飞行拍翼",
	"Fly Glide": "飞行滑翔",
	"Flying Forward": "向前飞行",
	"Flying Forward Super": "高速向前飞行",
	"Glide": "滑翔",
	"Greeting": "打招呼",
	"Head Nod": "点头",
	"Hit": "受击",
	"Hit_Chest": "胸部受击",
	"Hit_Head": "头部受击",
	"Hit_Knockback": "受击击退",
	"Hit_Knockback_RM": "受击击退 RM",
	"Howl": "嚎叫",
	"Idle": "待机",
	"Idle Alert": "警觉待机",
	"Idle Listening": "聆听待机",
	"Idle_FoldArms_Loop": "抱臂待机循环",
	"Idle_Lantern_Loop": "提灯待机循环",
	"Idle_Loop": "待机循环",
	"Idle_No_Loop": "拒绝待机循环",
	"Idle_Rail_Call": "栏杆呼叫",
	"Idle_Rail_Loop": "栏杆待机循环",
	"Idle_Shield_Break": "盾牌破防",
	"Idle_Shield_Loop": "持盾待机循环",
	"Idle_Talking_Loop": "说话待机循环",
	"Idle_TalkingPhone_Loop": "打电话待机循环",
	"Idle_Torch_Loop": "火把待机循环",
	"Interact": "互动",
	"Jog_Fwd_Loop": "慢跑前进循环",
	"Jump": "跳跃",
	"Jump Attack": "跳跃攻击",
	"Jump_Land": "跳跃落地",
	"Jump_Loop": "跳跃滞空循环",
	"Jump_Start": "起跳",
	"Jumping Jacks": "开合跳",
	"Kneeling Tired": "疲惫跪姿",
	"LayToIdle": "躺下转待机",
	"Levitate Entrance": "进入悬浮",
	"Levitate Idle": "悬浮待机",
	"Meditate": "冥想",
	"Melee_Hook": "近战勾拳",
	"Melee_Hook_Rec": "近战勾拳恢复",
	"NinjaJump_Idle_Loop": "忍者跳待机循环",
	"NinjaJump_Land": "忍者跳落地",
	"NinjaJump_Start": "忍者跳起跳",
	"OverhandThrow": "过肩投掷",
	"PickUp_Table": "从桌上拿起",
	"Pistol_Aim_Down": "手枪向下瞄准",
	"Pistol_Aim_Neutral": "手枪平视瞄准",
	"Pistol_Aim_Up": "手枪向上瞄准",
	"Pistol_Idle_Loop": "手枪待机循环",
	"Pistol_Reload": "手枪换弹",
	"Pistol_Shoot": "手枪射击",
	"Power Up": "蓄力",
	"Punch_Cross": "交叉拳",
	"Punch_Enter": "出拳进入",
	"Punch_Jab": "刺拳",
	"Push_Loop": "推动循环",
	"Pushup": "俯卧撑",
	"Reject": "拒绝",
	"Rest Pose": "静止姿势",
	"Roar": "咆哮",
	"Roll": "翻滚",
	"Roll_RM": "翻滚 RM",
	"Run": "奔跑",
	"Run Anime": "动漫跑",
	"Shield_Dash_RM": "盾牌冲刺 RM",
	"Shield_OneShot": "盾牌一次动作",
	"Shivering": "发抖",
	"Side winding": "侧向蜿蜒",
	"Sit": "坐下",
	"Sitting_Enter": "进入坐姿",
	"Sitting_Exit": "离开坐姿",
	"Sitting_Idle_Loop": "坐姿待机循环",
	"Sitting_Talking_Loop": "坐姿说话循环",
	"Sleeping": "睡觉",
	"Slide_Exit": "滑行动作结束",
	"Slide_Loop": "滑行循环",
	"Slide_Start": "滑行动作开始",
	"Sneak": "潜行",
	"Spell_Simple_Enter": "施法进入",
	"Spell_Simple_Exit": "施法结束",
	"Spell_Simple_Idle_Loop": "施法待机循环",
	"Spell_Simple_Shoot": "施法发射",
	"Sprint_Loop": "冲刺循环",
	"Swim": "游动",
	"Swim_Fwd_Loop": "向前游动循环",
	"Swim_Idle_Loop": "游泳待机循环",
	"Sword_Attack": "剑攻击",
	"Sword_Attack_RM": "剑攻击 RM",
	"Sword_Block": "剑格挡",
	"Sword_Dash_RM": "剑冲刺 RM",
	"Sword_Idle": "持剑待机",
	"Sword_Regular_A": "剑普通攻击 A",
	"Sword_Regular_A_Rec": "剑普通攻击 A 恢复",
	"Sword_Regular_B": "剑普通攻击 B",
	"Sword_Regular_B_Rec": "剑普通攻击 B 恢复",
	"Sword_Regular_C": "剑普通攻击 C",
	"Sword_Regular_Combo": "剑连击",
	"T-Pose": "T-Pose",
	"Tail Attack": "尾击",
	"Thow Object": "投掷物体",
	"Throw Object": "投掷物体",
	"Tired": "疲惫",
	"Tired Hunched": "疲惫弯腰",
	"TPose": "T-Pose",
	"TreeChopping_Loop": "砍树循环",
	"Two-hand Blast": "双手冲击",
	"Victory": "胜利",
	"Victory Fist Pump": "握拳庆祝",
	"Walk": "行走",
	"Walk RM": "行走 RM",
	"Walk_Carry_Loop": "搬运行走循环",
	"Walk_Formal_Loop": "正式行走循环",
	"Walk_Loop": "行走循环",
	"Yes": "点头同意",
	"Zombie_Idle_Loop": "僵尸待机循环",
	"Zombie_Scratch": "僵尸抓挠",
	"Zombie_Walk_Fwd_Loop": "僵尸前进循环",
	"Show skeleton": "显示骨骼",
	"Mirror animations": "镜像动画",
	"Global": "全局",
	"Local": "局部",
	"Translation": "平移",
	"Translate": "平移",
	"Rotation": "旋转",
	"Rotate": "旋转",
	"Weights": "权重",
	"Weight painted mesh": "权重涂色网格",
	"Textured": "贴图",
	"Textured Mesh": "贴图网格",
	"Reset": "重置",
	"Reset Skeleton Scale": "重置骨骼缩放",
	"Reset A-Pose": "重置 A-Pose",
	"Undo": "撤销",
	"Redo": "重做",
	"Undo (Ctrl+Z)": "撤销 (Ctrl+Z)",
	"Redo (Ctrl+Y)": "重做 (Ctrl+Y)",
	"Bring your own rigged model": "导入你自己的绑定模型",
	"Instructions and information go here with what this page is for": "上传带骨骼的模型，并把 Mesh2Motion 动画重定向到目标骨架。",
	"Mesh2Motion Skeleton (Source)": "Mesh2Motion 骨架（源）",
	"Bones List": "骨骼列表",
	"No source skeleton loaded": "未加载源骨架",
	"Your 3D Rig Model (Target)": "你的 3D 绑定模型（目标）",
	"Upload Rig": "上传骨架模型",
	"Auto-Map Bones": "自动映射骨骼",
	"Clear Mappings": "清空映射",
	"No target skeleton loaded": "未加载目标骨架",
	"Continue": "继续",
	"No matching source bones": "没有匹配的源骨骼",
	"No matching target bones": "没有匹配的目标骨骼",
	"Remove this mapping": "删除此映射",
	"Target Skeleton Hierarchy": "目标骨架层级",
	"Source Skeleton Scene (Mesh2Motion)": "源骨架场景（Mesh2Motion）",
	"Ask questions or provide feedback": "提问或反馈",
	"Check out the": "查看",
	"Visit Discord Server": "访问 Discord 服务器",
	"Visit YouTube Channel": "访问 YouTube 频道",
	"See social media account": "查看社交媒体账号",
	"Scott Petrovic: Project Maintainer": "Scott Petrovic：项目维护者",
}));

const ATTRIBUTE_MAP = new Map(Object.entries({
	"GLB and FBX preferred. ZIP is for GLTF+BIN and textures separately. DAE+textures is also supported in ZIP format.": "推荐使用 GLB 或 FBX；GLTF+BIN+贴图请打包为 ZIP，DAE+贴图也支持 ZIP。",
	"Replaces all materials with a 'normal' shader for debugging": "用法线着色器替换所有材质，便于调试。",
	"Variations on which finger bones you want to keep. Single Hand Bone removes all fingers and keeps only the hand bone.": "选择保留哪些手指骨骼。单一手骨会移除全部手指，只保留手部骨骼。",
	"Adjust the overall scale of the skeleton": "调整骨骼整体缩放。",
	"If you are having issues with the arms distorting your head (e.g. chibi characters), use a divider to help define the head area.": "如果手臂影响头部权重（例如 Q 版角色），可用分隔平面辅助限定头部区域。",
	"If your model uses an A-Pose, this will help expand/contract arms for all animations": "如果模型是 A-Pose，可用它为所有动画展开或收拢手臂。",
	"Export animations. Make sure to select the animations you want to export first.": "导出动画。请先选择要导出的动画。",
	"Show skeleton": "显示骨骼",
	"Mirror animations": "镜像动画",
	"Camera presets": "相机预设",
	"Camera tuning": "相机调节",
	"Animations": "动画",
	"Skeleton": "骨骼",
	"Reset Skeleton Scale": "重置骨骼缩放",
	"Reset A-Pose": "重置 A-Pose",
	"Undo": "撤销",
	"Redo": "重做",
	"Undo (Ctrl+Z)": "撤销 (Ctrl+Z)",
	"Redo (Ctrl+Y)": "重做 (Ctrl+Y)",
	"Weights": "权重",
	"Weight painted mesh": "权重涂色网格",
	"Textured": "贴图",
	"Textured Mesh": "贴图网格",
	"Translate": "平移",
	"Translation": "平移",
	"Rotate": "旋转",
	"Rotation": "旋转",
	"Global": "全局",
	"Local": "局部",
	"Filter animations...": "筛选动画...",
	"Remove this mapping": "删除此映射",
}));

const TITLE_MAP = new Map(Object.entries({
	"Mesh2Motion - Create (Window)": "Mesh2Motion - 创建",
	"Mesh2Motion - Explore (Window)": "Mesh2Motion - 浏览",
	"Mesh2Motion - Explore": "Mesh2Motion - 浏览",
	"Mesh2Motion - Retarget": "Mesh2Motion - 重定向",
}));

const ATTRIBUTES = ["placeholder", "title", "alt", "data-tippy-content", "aria-label"];
const STYLE_ID = "gjj-mesh2motion-cn-style";

const CAMERA_TUNING_TEXT_MAP = new Map(Object.entries({
	"Preset": "预设",
	"Duration": "时长",
	"Lens": "镜头",
	"Speed": "速度",
	"FOV Scale": "视角缩放",
	"Path Scale": "路径缩放",
	"Yaw": "偏航",
	"Roll": "滚转",
	"Offset (XYZ)": "位置偏移 (XYZ)",
	"Reverse": "反向",
	"Loop": "循环",
	"Reset": "重置",
	"Pick a camera preset to enable tuning.": "请选择相机预设后再调节。",
}));

const ICON_MAP = new Map(Object.entries({
	"accessibility_new": "骨",
	"animation": "动",
	"videocam": "相",
	"tune": "调",
	"play_arrow": "▶",
	"pause": "Ⅱ",
	"stop": "■",
	"restart_alt": "↺",
	"repeat": "↻",
	"all_inclusive": "∞",
	"save_alt": "↓",
	"download": "↓",
	"upload": "↑",
	"help": "?",
	"close": "×",
	"settings": "设",
}));

const ICON_LABEL_MAP = new Map(Object.entries({
	"accessibility_new": "骨骼",
	"animation": "动画",
	"videocam": "相机预设",
	"tune": "相机调节",
	"play_arrow": "播放",
	"pause": "暂停",
	"stop": "停止",
	"restart_alt": "重置",
	"repeat": "循环播放",
	"all_inclusive": "循环模型动画",
	"save_alt": "下载",
	"download": "下载",
	"upload": "上传",
	"help": "帮助",
	"close": "关闭",
	"settings": "设置",
}));

const TEXT_NORMALIZED_MAP = buildNormalizedMap(TEXT_MAP, ATTRIBUTE_MAP);
const CAMERA_TUNING_NORMALIZED_MAP = buildNormalizedMap(CAMERA_TUNING_TEXT_MAP);

function preserveWhitespace(original, translated) {
	const leading = original.match(/^\s*/)?.[0] || "";
	const trailing = original.match(/\s*$/)?.[0] || "";
	return `${leading}${translated}${trailing}`;
}

function normalizeLookupText(text) {
	return String(text || "")
		.trim()
		.replace(/[’']/g, "")
		.replace(/[_,-]+/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function buildNormalizedMap(...maps) {
	const normalized = new Map();
	for (const map of maps) {
		for (const [key, value] of map.entries()) {
			const normalizedKey = normalizeLookupText(key);
			if (normalizedKey && !normalized.has(normalizedKey)) {
				normalized.set(normalizedKey, value);
			}
		}
	}
	return normalized;
}

function ensureStyle() {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-cn-icon-text {
	font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
	font-size: 12px !important;
	font-weight: 700;
	line-height: 1 !important;
	letter-spacing: 0 !important;
	text-transform: none !important;
	white-space: nowrap !important;
}
#activity-bar .gjj-cn-icon-text,
#activity-bar-left .gjj-cn-icon-text,
.activity-bar .gjj-cn-icon-text,
.activity-btn .gjj-cn-icon-text {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	font-size: 13px !important;
}
`;
	document.head.appendChild(style);
}

function translateIconElement(element) {
	if (!element.classList?.contains("material-symbols-outlined")) {
		return false;
	}
	const raw = element.textContent.trim();
	const translated = ICON_MAP.get(raw);
	if (!translated) {
		return false;
	}
	element.textContent = translated;
	element.classList.add("gjj-cn-icon-text");
	const label = ICON_LABEL_MAP.get(raw);
	if (label) {
		element.setAttribute("aria-label", label);
		element.setAttribute("title", label);
	}
	return true;
}

function translateIconTextNode(node) {
	const parent = node.parentElement;
	if (!parent?.classList?.contains("material-symbols-outlined")) {
		return false;
	}
	const raw = String(node.nodeValue || "").trim();
	const translated = ICON_MAP.get(raw);
	if (!translated) {
		return false;
	}
	parent.classList.add("gjj-cn-icon-text");
	const next = preserveWhitespace(node.nodeValue, translated);
	if (next !== node.nodeValue) {
		node.nodeValue = next;
	}
	const label = ICON_LABEL_MAP.get(raw);
	if (label) {
		parent.setAttribute("aria-label", label);
		parent.setAttribute("title", label);
	}
	return true;
}

function translateRaw(text) {
	const trimmed = String(text || "").trim();
	if (!trimmed) {
		return null;
	}
	if (TEXT_MAP.has(trimmed)) {
		return TEXT_MAP.get(trimmed);
	}
	if (ATTRIBUTE_MAP.has(trimmed)) {
		return ATTRIBUTE_MAP.get(trimmed);
	}
	const normalized = TEXT_NORMALIZED_MAP.get(normalizeLookupText(trimmed));
	if (normalized) {
		return normalized;
	}
	if (/^Download\s*$/.test(trimmed)) {
		return "下载";
	}
	if (/^Finish\s*(?:›|>)?$/i.test(trimmed)) {
		return /(?:›|>)$/.test(trimmed) ? "完成 ›" : "完成";
	}
	if (/^Test Skinning Algorithm\s*(?:›|>)?$/i.test(trimmed)) {
		return /(?:›|>)$/.test(trimmed) ? "测试蒙皮算法 ›" : "测试蒙皮算法";
	}
	const durationMatch = trimmed.match(/^(\d+)\s*f\s*\/\s*([0-9.]+)s\s*@\s*(\d+)fps$/i);
	if (durationMatch) {
		return `${durationMatch[1]}帧 / ${durationMatch[2]}秒 @ ${durationMatch[3]}fps`;
	}
	if (/^No animations found/i.test(trimmed)) {
		return "未找到动画";
	}
	if (/^No source skeleton loaded\.?$/i.test(trimmed)) {
		return "未加载源骨架";
	}
	if (/^No target skeleton loaded\.?$/i.test(trimmed)) {
		return "未加载目标骨架";
	}
	if (/^No matching source bones$/i.test(trimmed)) {
		return "没有匹配的源骨骼";
	}
	if (/^No matching target bones$/i.test(trimmed)) {
		return "没有匹配的目标骨骼";
	}
	if (/^Mapped:/i.test(trimmed)) {
		return trimmed.replace(/^Mapped:/i, "已映射：");
	}
	return null;
}

function translateContextRaw(text, element) {
	if (!element?.closest) {
		return null;
	}
	const trimmed = String(text || "").trim();
	if (!trimmed) {
		return null;
	}
	if (element.closest('[class*="camera-tune"]')) {
		if (CAMERA_TUNING_TEXT_MAP.has(trimmed)) {
			return CAMERA_TUNING_TEXT_MAP.get(trimmed);
		}
		const normalized = CAMERA_TUNING_NORMALIZED_MAP.get(normalizeLookupText(trimmed));
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function translateTextNode(node) {
	if (translateIconTextNode(node)) {
		return;
	}
	const contextTranslated = translateContextRaw(node.nodeValue, node.parentElement);
	if (contextTranslated !== null) {
		const next = preserveWhitespace(node.nodeValue, contextTranslated);
		if (next !== node.nodeValue) {
			node.nodeValue = next;
		}
		return;
	}
	const translated = translateRaw(node.nodeValue);
	if (translated !== null) {
		const next = preserveWhitespace(node.nodeValue, translated);
		if (next !== node.nodeValue) {
			node.nodeValue = next;
		}
	}
}

function translateElement(element) {
	if (!(element instanceof Element)) {
		return;
	}
	translateIconElement(element);
	for (const attr of ATTRIBUTES) {
		const value = element.getAttribute(attr);
		if (!value) {
			continue;
		}
		const translated = translateRaw(value);
		if (translated !== null && translated !== value) {
			element.setAttribute(attr, translated);
		}
	}
	if (element.tagName === "TITLE") {
		const title = TITLE_MAP.get(element.textContent.trim());
		if (title) {
			element.textContent = title;
			document.title = title;
		}
	}
}

function translateTree(root = document.body) {
	if (!root) {
		return;
	}
	if (root.nodeType === Node.TEXT_NODE) {
		translateTextNode(root);
		return;
	}
	if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
		return;
	}
	translateElement(root);
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	while (walker.nextNode()) {
		const current = walker.currentNode;
		if (current.nodeType === Node.TEXT_NODE) {
			translateTextNode(current);
		} else {
			translateElement(current);
		}
	}
}

let pending = false;
function scheduleTranslate(root = document.body) {
	if (pending) {
		return;
	}
	pending = true;
	requestAnimationFrame(() => {
		pending = false;
		translateTree(root);
	});
}

function boot() {
	ensureStyle();
	translateTree(document);
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === "characterData") {
				translateTextNode(mutation.target);
			}
			for (const node of mutation.addedNodes || []) {
				scheduleTranslate(node.nodeType === Node.ELEMENT_NODE ? node : document.body);
			}
			if (mutation.type === "attributes") {
				translateElement(mutation.target);
			}
		}
	});
	observer.observe(document.documentElement, {
		childList: true,
		characterData: true,
		attributes: true,
		subtree: true,
		attributeFilter: ATTRIBUTES,
	});
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
	boot();
}

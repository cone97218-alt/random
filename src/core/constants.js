/**
 * constants.js - Core constants and default configurations
 */

export const MODULE_NAME = 'random';

export const THEME_MODES = {
    FOLLOW: 'follow',
    MORANDI_BEIGE: 'morandi-beige',
    MORANDI_GRAY: 'morandi-gray',
};

export const SCOPE = {
    GLOBAL: 'global',
    CARD: 'card',
};

export const ROLE = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export const ROLE_LABELS = {
    [ROLE.SYSTEM]: 'System',
    [ROLE.USER]: 'User',
    [ROLE.ASSISTANT]: 'Assistant',
};

export const DEFAULT_LIFECYCLE = {
    useGlobal: true,
    everyXRounds: null, // null = every round
    keepYRounds: null,  // null = roll every time
};

export const DEFAULT_PANEL = {
    position: 'normal',
    width: '80',
    height: '70',
    theme: THEME_MODES.FOLLOW,
};

export const DEFAULT_MISC = {
    avoidRepetition: true,          // 防连续重复抽取
    enableCategoryGrouping: true,   // 启用宏配置组分类折叠分组视图
    converterStartIndex: 1,         // 导入起始编号
};

// Max macro nesting depth (prevents infinite loops)
export const MAX_NESTING_DEPTH = 10;

// ── Default AI Prompt Components ──────────────────────────────────────────────
// Modular functional prompt entries + natural transition anchors

export const DEFAULT_PROMPT_COMPONENTS = [
    {
        id: 'expert_role',
        label: '系统角色定位',
        builtinKey: 'expert_role',
        role: 'system',
        order: 0,
        enabled: true,
        editable: true,
        content: '你是一个酒馆(SillyTavern)随机宏引擎专家助手。你的任务是根据对话情境与用户要求，为随机宏系统设计高质量、结构严密的随机宏与宏配置组。',
    },
    {
        id: 'rule_group_spec',
        label: '规范：宏配置组',
        builtinKey: 'rule_group_spec',
        role: 'system',
        order: 1,
        enabled: true,
        editable: true,
        content: '【宏配置组规范】\n宏配置组是注入给模型的提示词单元。包含：\n- groupName：清晰概括主题的中文组名称（如“突发事件发生器”）。\n- template：注入提示词模板，通过嵌入 `{{random_中文宏名}}` 动态引用宏。\n- injectionRole：注入身份（0:System / 1:User / 2:Assistant，默认0）。\n- injectionDepth：注入深度（如 4 表示倒数第4条消息处注入）。',
    },
    {
        id: 'rule_macro_spec',
        label: '规范：宏命名与触发概率',
        builtinKey: 'rule_macro_spec',
        role: 'system',
        order: 2,
        enabled: true,
        editable: true,
        content: '【宏命名与概率规范】\n- 宏标识 id 必须使用直观易懂的【中文命名】（如 `天气`、`突发状况`、`路人态度`），严禁使用英文长词缀。\n- 引用宏时格式固定为 `{{random_中文宏名}}`（如 `{{random_天气}}`）。\n- triggerProbability：该宏的激活概率（0-100，默认100）。未激活时宏输出为空。',
    },
    {
        id: 'rule_option_spec',
        label: '规范：宏内容、权重与嵌套',
        builtinKey: 'rule_option_spec',
        role: 'system',
        order: 3,
        enabled: true,
        editable: true,
        content: '【宏内容、权重与宏嵌套规范】\n- options：候选选项列表。\n- text：选项文本内容。\n- ★宏嵌套机制：选项文本中可以继续嵌入其他宏标签（例如在 `天气` 选项中写 `突降暴雨，同时伴有{{random_次生灾害}}`），系统将在触发时自动递归多级展开，实现复杂多变的组合生成！\n- weight：相对抽取权重（正整数，默认1）。权重越高被抽中的概率越大。',
    },
    {
        id: 'rule_output_format',
        label: '规范：输出格式',
        builtinKey: 'rule_output_format',
        role: 'system',
        order: 4,
        enabled: true,
        editable: true,
        content: '【输出格式规范】\n根据用户需求场景选择以下相应格式输出（使用 ```json 代码块包裹）：\n\n一、★ 点对点局部修改模式（当用户要求对已有注入宏组进行添加、修改、删除、调权、微调模板等局部变更时，强制使用此模式输出增量指令，切勿输出未修改的重复数据）：\n{\n  "isPatch": true,\n  "summary": "简述本次修改内容",\n  "operations": [\n    {\n      "op": "add_options",\n      "macroId": "中文宏名",\n      "options": [\n        { "text": "新选项内容", "weight": 1, "tag": "标签(可选)" }\n      ]\n    },\n    {\n      "op": "replace_option",\n      "macroId": "中文宏名",\n      "target": "待替换的原选项文本",\n      "newText": "修改后的新文本",\n      "newWeight": 2\n    },\n    {\n      "op": "remove_options",\n      "macroId": "中文宏名",\n      "matches": ["待删除的选项文本1", "待删除的选项文本2"]\n    },\n    {\n      "op": "update_template",\n      "template": "[修改后的完整注入模板：{{random_xxx}}...]" \n    },\n    {\n      "op": "update_macro",\n      "macroId": "中文宏名",\n      "triggerProbability": 80\n    },\n    {\n      "op": "add_macro",\n      "macroId": "新中文宏名",\n      "triggerProbability": 100,\n      "options": [{ "text": "选项1", "weight": 1 }]\n    },\n    {\n      "op": "remove_macro",\n      "macroId": "待移除的宏名"\n    }\n  ]\n}\n\n二、全新宏组规划模式（当用户要求新建或从零规划完整宏组时）：\n{\n  "isFullGroup": true,\n  "groupName": "局势动荡生成器",\n  "template": "[当前局势事件：{{random_政治风波}}，引发了{{random_民众反应}}]",\n  "injectionRole": 0,\n  "injectionDepth": 4,\n  "macros": [\n    {\n      "id": "政治风波",\n      "triggerProbability": 100,\n      "options": [\n        { "text": "【清洗名单外泄】一份来自高层的机密文件遭公开", "weight": 1 },\n        { "text": "【边境戒严】国防部紧急发布一级战备指令", "weight": 2 }\n      ]\n    }\n  ]\n}\n\n三、纯选项生成模式：若用户仅要求为某单个宏生成候选项，每行输出一个文本即可。',
    },
    {
        id: 'anchor_context_lead',
        label: '引导：上下文衔接',
        builtinKey: 'anchor_context_lead',
        role: 'system',
        order: 5,
        enabled: true,
        editable: true,
        content: '以下提供当前酒馆会话的设定、世界书与聊天上下文，请严格参考这些背景生成贴合场景的宏内容：',
    },
    {
        id: 'world_info_before',
        label: 'World Info (before)',
        builtinKey: 'world_info_before',
        role: 'system',
        order: 6,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'persona',
        label: 'Persona Description',
        builtinKey: 'persona',
        role: 'system',
        order: 7,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'char_desc',
        label: 'Char Description',
        builtinKey: 'char_desc',
        role: 'system',
        order: 8,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'char_personality',
        label: 'Char Personality',
        builtinKey: 'char_personality',
        role: 'system',
        order: 9,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'scenario',
        label: 'Scenario',
        builtinKey: 'scenario',
        role: 'system',
        order: 10,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'world_info_after',
        label: 'World Info (after)',
        builtinKey: 'world_info_after',
        role: 'system',
        order: 11,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'chat_history',
        label: 'Chat History',
        builtinKey: 'chat_history',
        role: 'user',
        order: 12,
        enabled: true,
        editable: false,
        content: null,
        chatHistoryX: 10,
        regex: '',
        regexReplace: '',
    },
    {
        id: 'world_info_depth',
        label: 'World Info (at depth)',
        builtinKey: 'world_info_depth',
        role: 'system',
        order: 13,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'anchor_history_lead',
        label: '引导：生成意图衔接',
        builtinKey: 'anchor_history_lead',
        role: 'system',
        order: 14,
        enabled: true,
        editable: true,
        content: '以下是本拓展内的生成对话历史与用户的具体需求，请根据上述背景与规范执行生成：',
    },
    {
        id: 'ext_chat_history',
        label: '扩展对话历史',
        builtinKey: 'ext_chat_history',
        role: 'user',
        order: 15,
        enabled: true,
        editable: false,
        content: null,
    },
    {
        id: 'ext_user_input',
        label: '用户输入',
        builtinKey: 'ext_user_input',
        role: 'user',
        order: 16,
        enabled: true,
        editable: false,
        content: null,
    },
];

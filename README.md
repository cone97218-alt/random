# 随机宏引擎 (Random Macro Extension for SillyTavern)

专为 SillyTavern（酒馆）设计的随机宏与提示词注入拓展。支持多层嵌套宏定义、权重抽取、作用域隔离（全局/单卡）、生命周期轮次控制、酒馆原生嵌套宏一键转换以及 AI 辅助批量生成。

---

## 🌟 核心特性

- **🎲 丰富的触发入口**：
  - 聊天输入框左侧 / QR 栏骰子快捷按钮（左键呼出面板，右键一键重 Roll）。
  - 全功能斜杠命令支持：`/random`、`/random-panel`、`/random-roll`（支持子命令与参数自动补全）。
- **🧩 宏嵌套与递归解析**：
  - 支持在宏选项中嵌套调用 `{{random_xxx}}`，内置环形引用检测与最大深度保护。
- **🔌 深度上下文注入**：
  - 完美适配主流 Chat Completion（OpenAI / Claude / DeepSeek / OpenRouter）与 Text Completion。
  - 支持自定义注入深度（Depth）与注入角色（System / User / Assistant）。
- **⏳ 灵活的生命周期规则**：
  - 支持设置每 $X$ 轮注入一次（`everyXRounds`）与注入后结果保持 $Y$ 轮（`keepYRounds`）。
- **📌 状态持久化与图钉锁定**：
  - 随聊天会话（`chat_metadata`）独立隔离与存档，支持在 UI 中一键 Pin 固定特定抽取结果。
- **🔄 酒馆原生宏一键转换**：
  - 支持输入酒馆原生的嵌套宏（如 `{{random::我喜欢{{random::草莓,苹果}},我讨厌{{random::草莓,香蕉}}}}`），一键解析并自动生成规范宏组与递归宏定义。
- **🪄 AI 智能生成**：
  - 支持向 AI 描述需求，自动批量生成宏词条与权重并导入。

---

## 📦 安装方法

1. 进入 SillyTavern 根目录：`public/scripts/extensions/third-party/`
2. 克隆本仓库：
   ```bash
   git clone https://github.com/cone97218-alt/random.git random
   ```
3. 刷新 SillyTavern 网页即可使用。

---

## ⌨️ 斜杠命令速查

| 命令 | 说明 |
| :--- | :--- |
| `/random` 或 `/random open` | 打开管理面板 |
| `/random roll [组名]` | 重新抽取指定宏组（留空重抽全部） |
| `/random toggle [组名]` | 快速启用/禁用指定宏组 |
| `/random convert [酒馆宏文本]` | 解析并导入酒馆原生 `{{random::...}}` 宏 |
| `/random test` 或 `/random inject` | 手动触发一次注入测试并查看 ST 上下文生效详情 |
| `/random status` | 查看所有宏组状态及当前注入生效情况 |
| `/random clear` | 清空当前会话宏缓存与注入 |

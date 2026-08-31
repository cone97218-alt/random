/**
 * index.js - Random Macro Extension main entry point
 *
 * Exclusively provides 2 clean entry mechanisms:
 *   1. QR bar / Chat input dice icon button
 *   2. Rich Slash Commands: /random, /random-panel, /random-roll
 *
 * No extensions menu button (magic wand) is created or registered.
 */

import { getContext } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../slash-commands/SlashCommandEnumValue.js';
import { showPanel } from './src/ui/panel.js';
import { registerHooks } from './src/core/hooks.js';
import { injectThemeRgbVariables } from './src/utils/theme.js';
import { getAllGroups, getGroupChatState, saveChatState, saveGroup, clearChatState } from './src/core/storage.js';
import { resolveGroupTemplate } from './src/core/macro-engine.js';
import { injectRandomMacros, clearAllInjections } from './src/core/injection.js';
import { convertStRandomMacros, importConvertedGroup } from './src/core/st-converter.js';
import { showToast } from './src/utils/dom.js';

const QR_BTN_ID = 'random-qr-btn';

// ── 1. QR Bar & Chat Bar Button Injection ─────────────────────────────────────

function createTriggerButton(isQrBar = true) {
    const btn = document.createElement('div');
    btn.id = QR_BTN_ID;
    btn.tabIndex = 0;
    btn.role = 'button';
    btn.title = '随机宏引擎 (左键打开面板 / 右键快速重抽)';

    if (isQrBar) {
        btn.className = 'qr--button menu_button interactable';
        btn.innerHTML = '<i class="fa-solid fa-dice"></i>';
    } else {
        btn.className = 'fa-solid fa-dice interactable random-chat-bar-btn';
    }

    // Left click -> Open Panel
    btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        showPanel();
    });

    // Right click -> Quick re-roll all active macro groups
    btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        executeQuickReroll();
    });

    return btn;
}

/**
 * Perform a quick re-roll of all active macro groups with feedback.
 */
function executeQuickReroll(targetGroupName = null) {
    const groups = getAllGroups();
    if (!groups.length) {
        showToast('暂无宏组配置', 'info');
        return;
    }

    if (targetGroupName) {
        const group = groups.find(g =>
            g.id.toLowerCase() === targetGroupName.toLowerCase() ||
            g.name.toLowerCase() === targetGroupName.toLowerCase()
        );
        if (!group) {
            showToast(`未找到宏组: ${targetGroupName}`, 'error');
            return;
        }
        const state = getGroupChatState(group.id);
        const { newValues, resolved } = resolveGroupTemplate(group, state, true);
        state.currentValues = newValues;
        saveChatState();
        showToast(`宏组【${group.name}】已重抽: ${resolved.substring(0, 35)}${resolved.length > 35 ? '...' : ''}`, 'success');
        return;
    }

    const enabledGroups = groups.filter(g => g.enabled);
    if (!enabledGroups.length) {
        showToast('当前没有已启用的宏组', 'info');
        return;
    }

    let count = 0;
    enabledGroups.forEach(g => {
        const state = getGroupChatState(g.id);
        const { newValues } = resolveGroupTemplate(g, state, true);
        state.currentValues = newValues;
        count++;
    });
    saveChatState();
    showToast(`🎲 随机宏：已重新抽取 ${count} 个宏组`, 'success');
}

/**
 * Smartly inject the trigger button into the best available DOM location:
 * 1. Inside Quick Reply container (#qr--bar .qr--buttons or #qr--bar)
 * 2. Next to options_button inside #leftSendForm
 * 3. Inside #send_form
 */
function injectTriggerButton() {
    const existing = document.getElementById(QR_BTN_ID);

    // Target 1: Quick Reply bar (.qr--buttons or #qr--bar)
    const qrContainer = document.querySelector('#qr--bar .qr--buttons') || document.querySelector('#qr--bar');
    if (qrContainer) {
        if (existing && qrContainer.contains(existing)) return;
        existing?.remove();
        qrContainer.appendChild(createTriggerButton(true));
        return;
    }

    // Target 2: #leftSendForm (next to options_button)
    const leftSendForm = document.getElementById('leftSendForm');
    if (leftSendForm) {
        if (existing && leftSendForm.contains(existing)) return;
        existing?.remove();
        leftSendForm.appendChild(createTriggerButton(false));
        return;
    }

    // Target 3: Fallback within send_form
    const sendForm = document.getElementById('send_form') || document.getElementById('form_sheld');
    if (sendForm) {
        if (existing && sendForm.contains(existing)) return;
        existing?.remove();
        sendForm.appendChild(createTriggerButton(true));
    }
}

// ── 2. Slash Commands ─────────────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        if (!SlashCommandParser || !SlashCommand) return;

        const subcommands = ['open', 'roll', 'toggle', 'convert', 'status', 'list', 'test', 'inject', 'clear', 'help'];
        const viewEnums = ['manage', 'generate', 'settings'];

        // Helper to get dynamic group name enums for autocomplete
        const getGroupEnumValues = () => {
            return getAllGroups().map(g => new SlashCommandEnumValue(g.name, g.name, `[${g.enabled ? '启用' : '禁用'}] 宏组: ${g.name}`));
        };

        // 1. Primary Command: /random (aliases: /rand, /random-macro)
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'random',
            aliases: ['rand', 'random-macro'],
            helpString: '随机宏引擎控制：/random [open|roll|toggle|convert|status|clear|help] [宏组名/视图/酒馆宏文本]',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '子命令 (open, roll, toggle, convert, status, clear, help) 或宏组名/视图',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: 'open',
                    enumList: subcommands.map(cmd => new SlashCommandEnumValue(cmd, cmd, `随机宏子命令: ${cmd}`)),
                }),
                SlashCommandArgument.fromProps({
                    description: '参数 (宏组名称 或 打开的视图: manage, generate, settings)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: '',
                    enumProvider: getGroupEnumValues,
                }),
            ],
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'view',
                    description: '指定打开的视图 (manage, generate, settings)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: viewEnums.map(v => new SlashCommandEnumValue(v, v, `切换到 ${v} 视图`)),
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'group',
                    description: '指定操作的宏组名称或ID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumProvider: getGroupEnumValues,
                }),
            ],
            callback: (namedArgs, unnamedArgs) => {
                let sub = '';
                let target = '';

                if (Array.isArray(unnamedArgs)) {
                    sub = (unnamedArgs[0] || '').toString().trim().toLowerCase();
                    target = (unnamedArgs[1] || '').toString().trim();
                } else if (typeof unnamedArgs === 'string') {
                    const parts = unnamedArgs.trim().split(/\s+/);
                    sub = parts[0]?.toLowerCase() || '';
                    target = parts.slice(1).join(' ').trim();
                }

                if (namedArgs?.view) {
                    showPanel(namedArgs.view.toString().trim().toLowerCase());
                    return '';
                }

                if (namedArgs?.group) {
                    target = namedArgs.group.toString().trim();
                }

                switch (sub) {
                    case '':
                    case 'open':
                    case 'panel':
                    case 'ui':
                    case 'show': {
                        const view = target && viewEnums.includes(target.toLowerCase()) ? target.toLowerCase() : null;
                        showPanel(view);
                        return '';
                    }
                    case 'roll':
                    case 'reroll': {
                        executeQuickReroll(target || null);
                        return '';
                    }
                    case 'toggle': {
                        if (!target) {
                            showToast('请指定要切换的宏组名称，例如：/random toggle 组名', 'info');
                            return '请指定要切换的宏组名称';
                        }
                        const groups = getAllGroups();
                        const group = groups.find(g =>
                            g.id.toLowerCase() === target.toLowerCase() ||
                            g.name.toLowerCase() === target.toLowerCase()
                        );
                        if (group) {
                            group.enabled = !group.enabled;
                            saveGroup(group);
                            showToast(`宏组【${group.name}】已${group.enabled ? '启用' : '禁用'}`, 'info');
                            return `宏组【${group.name}】状态已更新为：${group.enabled ? '已启用' : '已禁用'}`;
                        } else {
                            showToast(`未找到宏组: ${target}`, 'error');
                            return `未找到宏组: ${target}`;
                        }
                    }
                    case 'convert': {
                        if (!target) {
                            showToast('请提供要转换的酒馆宏文本，例如：/random convert {{random::A,B}}', 'info');
                            return '请提供要转换的酒馆宏文本。';
                        }
                        const parsed = convertStRandomMacros(target);
                        if (!parsed.macros.length) {
                            showToast('未检测到有效的 {{random::...}} 语法结构', 'error');
                            return '未检测到有效的 {{random::...}} 语法结构。';
                        }
                        const { macroCount } = importConvertedGroup({
                            groupName: parsed.groupName,
                            template: parsed.template,
                            macros: parsed.macros,
                        });
                        showToast(`成功解析并导入宏组【${parsed.groupName}】及 ${macroCount} 个关联宏！`, 'success');
                        return `【酒馆宏转换导入成功】\n• 宏组名称: ${parsed.groupName}\n• 注入模板: ${parsed.template}\n• 拆解宏数量: ${macroCount} 个\n已自动保存至宏列表并立即可用！`;
                    }
                    case 'test':
                    case 'inject': {
                        injectRandomMacros();
                        const ctx = getContext();
                        const ep = ctx.extension_prompts || {};
                        const injectedKeys = Object.keys(ep).filter(k => k.startsWith('random_group_'));
                        if (!injectedKeys.length) {
                            showToast('未检测到注入内容（请检查是否有启用的宏组及模板）', 'info');
                            return '【随机宏注入测试】当前未注入任何内容，请确保已有启用的宏组并配置了模板。';
                        }
                        const details = injectedKeys.map(k => {
                            const p = ep[k];
                            return `• ${k}: [深度:${p.depth}, 角色:${p.role}, 位置:${p.position}]\n  内容: "${p.value}"`;
                        }).join('\n');
                        showToast(`成功触发注入！已注入 ${injectedKeys.length} 项到 ST 上下文`, 'success');
                        return `【随机宏注入测试成功】\n${details}`;
                    }
                    case 'status':
                    case 'list': {
                        const groups = getAllGroups();
                        if (!groups.length) {
                            showToast('暂无宏组配置', 'info');
                            return '随机宏引擎：当前无配置的宏组。';
                        }
                        const ctx = getContext();
                        const ep = ctx.extension_prompts || {};
                        const lines = groups.map(g => {
                            const state = getGroupChatState(g.id);
                            const valCount = Object.keys(state.currentValues || {}).length;
                            const isCurrentlyInjected = Boolean(ep[`random_group_${g.id}`]?.value);
                            return `• [${g.enabled ? '✓' : '✗'}] ${g.name} (已抽取: ${valCount}项, 深度: ${g.injectionDepth ?? 4}, 当前ST注入: ${isCurrentlyInjected ? '已生效' : '未注入'})`;
                        });
                        const report = `【随机宏引擎状态】\n${lines.join('\n')}`;
                        showToast(`共有 ${groups.length} 个宏组 (${groups.filter(g => g.enabled).length} 已启用)`, 'info');
                        return report;
                    }
                    case 'clear': {
                        clearChatState();
                        clearAllInjections();
                        showToast('已清除当前会话的随机宏抽取与注入缓存', 'success');
                        return '已清除当前会话的随机宏抽取与注入缓存。';
                    }
                    case 'help': {
                        return [
                            '【随机宏引擎 斜杠命令使用指南】',
                            '• /random 或 /random open : 打开管理面板',
                            '• /random open [manage|generate|settings] : 打开指定视图',
                            '• /random roll [组名] : 重新抽取宏组（不填重抽全部已启用组）',
                            '• /random toggle [组名] : 启用/禁用指定宏组',
                            '• /random test 或 /random inject : 手动执行一次注入测试并查看注入详情',
                            '• /random status : 查看所有宏组状态及当前注入生效情况',
                            '• /random clear : 清空当前会话宏缓存与注入',
                            '• /random-roll [组名] : 快速重抽快捷命令',
                            '• /random-panel [视图] : 快速打开面板快捷命令',
                        ].join('\n');
                    }
                    default: {
                        // If sub matches a view name directly, open that view
                        if (viewEnums.includes(sub)) {
                            showPanel(sub);
                            return '';
                        }
                        // If sub matches a group name directly, roll it
                        const matchedGroup = getAllGroups().find(g => g.name.toLowerCase() === sub);
                        if (matchedGroup) {
                            executeQuickReroll(matchedGroup.name);
                            return '';
                        }
                        showPanel();
                        return '';
                    }
                }
            },
        }));

        // 2. Shortcut Command: /random-panel (aliases: /rand-panel)
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'random-panel',
            aliases: ['rand-panel'],
            helpString: '打开随机宏引擎控制面板：/random-panel [manage|generate|settings]',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '目标视图 (manage: 宏管理, generate: AI生成, settings: 拓展设置)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: 'manage',
                    enumList: viewEnums.map(v => new SlashCommandEnumValue(v, v, `打开 ${v} 视图`)),
                }),
            ],
            callback: (namedArgs, unnamedArgs) => {
                const view = (typeof unnamedArgs === 'string' ? unnamedArgs.trim() : (unnamedArgs?.[0] || '')) || 'manage';
                showPanel(viewEnums.includes(view.toLowerCase()) ? view.toLowerCase() : 'manage');
                return '';
            },
        }));

        // 3. Shortcut Command: /random-roll (aliases: /rand-roll)
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'random-roll',
            aliases: ['rand-roll'],
            helpString: '立即重新抽取随机宏：/random-roll [宏组名]',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '要重抽的宏组名称（留空则重抽所有已启用宏组）',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: '',
                    enumProvider: getGroupEnumValues,
                }),
            ],
            callback: (namedArgs, unnamedArgs) => {
                const target = typeof unnamedArgs === 'string' ? unnamedArgs.trim() : (unnamedArgs?.[0] || '').toString().trim();
                executeQuickReroll(target || null);
                return '';
            },
        }));

        console.log('[Random Macro] Slash commands registered successfully: /random, /random-panel, /random-roll');
    } catch (err) {
        console.warn('[Random Macro] Error registering slash commands:', err);
    }
}

// ── Lifecycle & Re-injection ──────────────────────────────────────────────────

function injectWithRetry(attempts = 0) {
    if (attempts > 30) return; // Retry up to ~15s
    injectTriggerButton();
    if (!document.getElementById(QR_BTN_ID)) {
        setTimeout(() => injectWithRetry(attempts + 1), 500);
    }
}

function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

// ── Extension Init ────────────────────────────────────────────────────────────

export async function init() {
    const ctx = getContext();
    const { eventSource, eventTypes } = ctx;

    // Inject theme RGB variables for CSS usage
    injectThemeRgbVariables();

    // Register ST event hooks (generation, swipes, etc.)
    registerHooks(eventSource, eventTypes);

    // Register Slash Commands (/random, /random-panel, /random-roll)
    registerSlashCommands();

    // Inject QR bar / chat bar trigger button
    injectTriggerButton();

    // Re-inject on chat change or app ready
    if (eventSource && eventTypes) {
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => injectTriggerButton());
        }
        if (eventTypes.APP_READY) {
            eventSource.on(eventTypes.APP_READY, () => injectTriggerButton());
        }
    }

    // MutationObserver: ensure button stays present across dynamic UI re-renders
    const handleMutation = debounce(() => {
        injectTriggerButton();
    }, 150);

    const observer = new MutationObserver(handleMutation);
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[Random Macro] Extension initialized: QR bar trigger and slash commands ready (no magic wand menu).');
}

// Auto-run init if DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', () => init());
}

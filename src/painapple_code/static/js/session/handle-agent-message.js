/**
 * Agent-stream handler mixin — interprets the inner Claude `agent_message`
 * payload (system/init, system/status, system/compact_boundary, system/
 * task_progress, assistant, user, result) that arrives wrapped inside the
 * server's `agent_message` envelope.
 *
 * Emits chat messages, drives activity strip, captures slash_commands +
 * permissionMode, tracks turn boundaries (turnId), and routes tool_use blocks
 * either to standalone messages or into the active thinking message
 * (currentThinkingMsgId).
 *
 * Special tool routing:
 *   - AskUserQuestion → handleAskUserQuestion (interactive form)
 *   - EnterPlanMode → flips permissionMode + tool block render
 *   - ExitPlanMode  → handleExitPlanMode (interactive approval card)
 *
 * Applied to Session.prototype via Object.assign in session.js.
 */

import S from '../strings.js';
import { debug } from '../config.js';
import { formatDuration } from '../utils.js';
import { getToolActivity } from '../activity-strip.js';

const getApp = () => window.app;

// Mirrors services/agent_session.py:1078 — tools the CLI handles itself
// (renders an interactive UI instead) and must never trigger the
// "blocked by <mode>" explainer, regardless of permission mode.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);

// Pull a single representative field from a tool_input dict so the deny
// explainer can show WHAT was denied, not just which tool. Returns the
// pre-formatted suffix (with leading space + parens) or '' when nothing
// useful is available — the explainer's `{details}` slot is then empty.
function summarizeToolInput(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    let snippet = '';
    switch (toolName) {
        case 'Bash': snippet = toolInput.command; break;
        case 'Edit': case 'Write': case 'MultiEdit':
        case 'NotebookEdit': case 'Read':
            snippet = toolInput.file_path; break;
        case 'Grep': case 'Glob': snippet = toolInput.pattern; break;
        case 'Task': snippet = toolInput.description || toolInput.subagent_type; break;
        case 'WebFetch': snippet = toolInput.url; break;
        case 'WebSearch': snippet = toolInput.query; break;
        default: return '';
    }
    if (!snippet) return '';
    snippet = String(snippet).replace(/\s+/g, ' ').trim();
    if (snippet.length > 100) snippet = snippet.slice(0, 97) + '...';
    return ` (${snippet})`;
}

export const agentStreamMethods = {
    handleAgentMessage(data, serverTimestamp = null) {
        const app = getApp();
        // Store server timestamp for use in addMessage/addThinkingMessage
        // This ensures client uses same timestamp as server for sync deduplication
        this._currentServerTimestamp = serverTimestamp;

        // Debug: log all claude messages
        debug.log('Claude message:', data.type, data.subtype || '', data);

        if (data.type === 'system' && data.subtype === 'init') {
            this.model = data.model;
            this.isAgentRunning = true;  // Claude started
            // Capture Claude's session_id for resuming later
            if (data.session_id) {
                this.providerSessionId = data.session_id;
                debug.log('Claude session ID:', data.session_id);
                app.sessionManager.saveSessions();  // Persist immediately
            }
            // Capture permission mode (plan, default, bypassPermissions, etc.)
            // Always update from init to clear stale plan mode after restarts
            if (data.permissionMode) {
                this.permissionMode = data.permissionMode;
            } else if (this.permissionMode) {
                // No permissionMode in init → not in plan mode, clear stale state
                this.permissionMode = null;
            }
            debug.log('Permission mode:', this.permissionMode);
            this.updateTab();
            if (this.isActive) {
                app.updateInputPlaceholder();
                if (window.permissionSettings) {
                    window.permissionSettings.currentLevel = this.permissionMode || 'bypassPermissions';
                    window.permissionSettings.updateButtonState();
                }
            }
            // Capture slash commands for autocomplete
            if (data.slash_commands) {
                this.slashCommands = data.slash_commands;
                debug.log('Slash commands:', this.slashCommands);
                app.sessionManager.saveSessions();  // Persist immediately
                // Update autocomplete if this is the active session
                if (this.isActive) {
                    app.updateSlashCommands(this.slashCommands);
                    // Fetch descriptions from server (commands were just saved by server)
                    if (this.cwd) {
                        app.fetchProjectCommands(this.cwd);
                    }
                }
            }
            if (this.isActive) {
                app.updateStatus();
                this._setActivity({ active: true, icon: 'sparkle', label: S.activity.states.starting });
            }
            return;
        }

        // Handle status messages from Claude CLI
        if (data.type === 'system' && data.subtype === 'status') {
            if (data.status === 'compacting') {
                this._compactStartTime = Date.now();
                this.addSystemLog(S.status.compacting);
                this._setActivity({ active: true, icon: 'compress', label: S.activity.states.compacting });
            } else if (data.compact_result) {
                // Compaction settle frame. success → a compact_boundary follows
                // within ms; failed → NO boundary ever comes. Either way the
                // turn keeps running to its result frame, so swap the compacting
                // label for generic working — a failed /compact must not pin
                // "compacting" on the strip until the result lands.
                if (data.compact_result !== 'success') {
                    this._compactStartTime = null;
                }
                this._setActivity({ active: true, icon: 'sparkle', label: S.activity.states.working });
            }
            // CLI reports its effective permissionMode in status frames on
            // transitions — plan enter/exit AND live set_permission_mode
            // switches (SDK control plane). Adopt it verbatim like the init
            // handler does: the engine is the authority. (The old code
            // collapsed everything non-plan to null, clobbering live mode
            // switches right after the WS reply had set them correctly.)
            if (data.permissionMode !== undefined) {
                const newMode = data.permissionMode || null;
                if (this.permissionMode !== newMode) {
                    this.permissionMode = newMode;
                    this.updateTab();
                    if (this.isActive) {
                        app.updateInputPlaceholder();
                        // Keep the permission button in sync (mirrors init)
                        if (window.permissionSettings) {
                            window.permissionSettings.currentLevel = newMode || 'bypassPermissions';
                            window.permissionSettings.updateButtonState();
                        }
                    }
                }
            }
            return;
        }

        // Handle compact_boundary - shows token savings after compaction
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
            const meta = data.compact_metadata || {};
            const preTokens = meta.pre_tokens || 0;
            const trigger = meta.trigger || 'unknown';
            const tokensK = (preTokens / 1000).toFixed(1);
            // Calculate compaction duration
            let durationStr = '';
            if (this._compactStartTime) {
                const elapsed = Date.now() - this._compactStartTime;
                durationStr = ` in ${formatDuration(elapsed)}`;
                this._compactStartTime = null;
            }
            // Show in main chat as an info message (not just system log).
            // sid mirrors the deterministic id the server stores for this same
            // boundary (agent_session.py: "compact-<frame uuid>"), so this live
            // copy and the synced server copy collapse to one row — their
            // content may differ (durationStr is client-only), identity may not.
            this.addMessage({
                role: 'info',
                sid: data.uuid ? `compact-${data.uuid}` : undefined,
                content: `Conversation compacted: ${tokensK}k tokens summarized${durationStr} (${trigger})`,
                timestamp: this._currentServerTimestamp || new Date().toISOString()
            });
            // The turn continues past the boundary (post-compaction inference) —
            // restore the generic working label for that phase.
            this._setActivity({ active: true, icon: 'sparkle', label: S.activity.states.working });
            return;
        }

        // Handle task_progress — live updates for background agents
        if (data.type === 'system' && data.subtype === 'task_progress') {
            this._handleTaskProgress(data);
            return;
        }

        if (data.type === 'assistant') {
            this.isAgentRunning = true;  // Claude is responding
            // Track turn boundaries: increment turnId when a new API message starts
            const apiMsgId = data.message?.id;
            if (apiMsgId && apiMsgId !== this._lastApiMessageId) {
                this._lastApiMessageId = apiMsgId;
                this.turnId++;
                // Clear thinking mode on new API message - if this message has a
                // thinking block, it will re-enter thinking mode in the forEach below.
                // Without this, a stale inThinkingMode from a previous message causes
                // tool-only messages (no thinking, no text) to route into old thinking groups.
                this.inThinkingMode = false;
            }
            const content = data.message?.content;
            const verifiedFiles = data.verifiedFiles || null;  // Server-verified file paths
            if (content && Array.isArray(content)) {
                content.forEach(block => {
                    if (block.type === 'thinking') {
                        // Enter thinking mode - subsequent tools go to thinking message
                        this.inThinkingMode = true;
                        this._setActivity({ active: true, icon: 'thinking', label: S.activity.states.thinking });
                        // Add thinking as a chat message (collapsible, persisted)
                        const thinkingMsg = this.addThinkingMessage(block.thinking);
                        this.currentThinkingMsgId = thinkingMsg.id;
                    } else if (block.type === 'text') {
                        // Text block ends thinking mode - within a single API message,
                        // tool_use blocks arrive BEFORE text, so all thinking tools are
                        // already captured. Subsequent tools should render standalone.
                        this.inThinkingMode = false;
                        // Suppress the CLI's synthetic auth-error bubble (model
                        // "<synthetic>", text "Failed to authenticate. API Error: 401…").
                        // The server's `auth_error` event renders a proper re-login
                        // affordance instead, so this raw bubble would just be noise.
                        if (data.message?.model === '<synthetic>'
                            && /failed to authenticate|api error:\s*401|authentication/i.test(block.text || '')) {
                            return;
                        }
                        // Don't change activity — keep showing the last tool activity
                        // (e.g. "Wrote server.py") rather than misleading "Writing..."
                        this.addMessage({ role: 'assistant', content: block.text, verifiedFiles });
                    } else if (block.type === 'tool_use') {
                        // Update activity strip with tool details
                        const activity = getToolActivity(block.name, block.input);
                        this._setActivity({ active: true, ...activity });
                        // Special handling for AskUserQuestion - render interactive form
                        if (block.name === 'AskUserQuestion') {
                            this.handleAskUserQuestion(block);
                        } else if (block.name === 'EnterPlanMode') {
                            // Claude entered plan mode - set permission mode
                            this.permissionMode = 'plan';
                            this.updateTab();  // Update tab badge
                            if (this.isActive) {
                                app.updateInputPlaceholder();  // Update placeholder
                                if (window.permissionSettings) {
                                    window.permissionSettings.currentLevel = 'plan';
                                    window.permissionSettings.updateButtonState();
                                }
                            }
                            app.sessionManager.saveSessions();  // Persist to localStorage
                            // Still render the tool block
                            if (this.inThinkingMode && this.currentThinkingMsgId) {
                                this.thinkingToolIds.add(block.id);
                                const parentTaskId = data.parent_task_id || null;
                                this.addToolToThinkingMessage(block, parentTaskId);
                            } else {
                                const parentTaskId = data.parent_task_id || null;
                                this.addToolUse(block, parentTaskId);
                            }
                        } else if (block.name === 'ExitPlanMode') {
                            // ExitPlanMode: show interactive approval card
                            this.permissionMode = null;
                            this.updateTab();
                            if (this.isActive) {
                                app.updateInputPlaceholder();
                                if (window.permissionSettings) {
                                    window.permissionSettings.currentLevel = 'bypassPermissions';
                                    window.permissionSettings.updateButtonState();
                                }
                            }
                            app.sessionManager.saveSessions();
                            this.handleExitPlanMode(block);
                        } else if (this.inThinkingMode && this.currentThinkingMsgId) {
                            // Route to thinking message (attach as nested tool)
                            this.thinkingToolIds.add(block.id);
                            // Pass parent_task_id from server for sub-agent tool grouping
                            const parentTaskId = data.parent_task_id || null;
                            this.addToolToThinkingMessage(block, parentTaskId);
                        } else {
                            // Pass parent_task_id for sub-agent tool grouping (also works without thinking mode)
                            const parentTaskId = data.parent_task_id || null;
                            this.addToolUse(block, parentTaskId);
                        }
                    } else {
                        // Unknown block type - log AND show in UI so we don't miss new types
                        debug.warn('Unhandled content block type:', block.type, block);
                        this.addMessage({
                            role: 'system',
                            content: `Unknown block type: ${block.type}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``,
                            source: 'unknown-block-type'
                        });
                    }
                });
            }
        }

        // Handle tool results - they come in "user" type messages with nested content
        if (data.type === 'user') {
            const content = data.message?.content;
            const verifiedFiles = data.verifiedFiles || null;  // Server-verified file paths (backwards compat)
            // Server provides child_tool_ids for Task completions (keyed by task_id)
            const childToolIdsMap = data.child_tool_ids || {};
            if (content && Array.isArray(content)) {
                content.forEach(block => {
                    if (block.type === 'tool_result') {
                        // Server now provides fileLinks with positions on each block
                        const fileLinks = block.fileLinks || null;
                        // Server provides startLine for Edit tools (parsed from output)
                        const startLine = block.startLine || null;
                        // Get child_tool_ids if this is a Task result
                        const childToolIds = childToolIdsMap[block.tool_use_id] || null;
                        // Normalize content: Claude API can return [{type:"text",text:"..."}]
                        let resultContent = block.content || '';
                        if (Array.isArray(resultContent)) {
                            resultContent = resultContent
                                .map(b => {
                                    if (typeof b === 'object' && b !== null) {
                                        return b.text || JSON.stringify(b, null, 2);
                                    }
                                    return String(b);
                                })
                                .join('\n');
                        }
                        // Headless CLI denies surface as tool_result with is_error=true.
                        // Two wordings observed:
                        //   1. dontAsk / generic: "Permission to use <Tool> has been denied..."
                        //      → replace verbose text with short summary + emit explainer
                        //   2. acceptEdits path-based: "Claude requested permissions to <verb> to <path>..."
                        //      → tool name isn't in the text; look it up by tool_use_id.
                        //        Leave the (already-short) verbose text alone; just emit explainer.
                        // ExitPlanMode is handled by the result.permission_denials safety net.
                        let denyToolName = null;
                        let denyToolInput = null;
                        let replaceWithSummary = false;
                        if (block.is_error && typeof resultContent === 'string') {
                            const m1 = resultContent.match(/^Permission to use (\S+) has been denied/);
                            const m2 = /^Claude requested permissions to \w+ to /.test(resultContent);
                            if (m1 || m2) {
                                const toolMsg = [...this.messages].reverse().find(
                                    m => m.role === 'tool' && m.toolType === 'use' && m.toolId === block.tool_use_id
                                );
                                denyToolName = m1 ? m1[1] : (toolMsg?.toolName || null);
                                denyToolInput = toolMsg?.toolInput || null;
                                replaceWithSummary = !!m1;
                            }
                        }
                        if (denyToolName && !INTERACTIVE_TOOLS.has(denyToolName)
                                && !this.findManualDenyCard(denyToolName, block.tool_use_id)) {
                            const modeKey = window.permissionSettings?.currentLevel || 'dontAsk';
                            const modeLabel = window.permissionSettings?.getModeLabel?.(modeKey) || modeKey;
                            if (replaceWithSummary) {
                                resultContent = S.permissions.deny_short
                                    .replace('{tool}', denyToolName)
                                    .replace('{mode}', modeLabel);
                            }
                            if (!this._deniedToolsThisTurn.has(denyToolName)) {
                                this._deniedToolsThisTurn.add(denyToolName);
                                this.addMessage({
                                    role: 'error',
                                    content: S.permissions.deny_explainer
                                        .replace('{tool}', denyToolName)
                                        .replace('{details}', summarizeToolInput(denyToolName, denyToolInput))
                                        .replace('{mode}', modeLabel),
                                    source: 'permission-denied'
                                });
                            }
                        }
                        // Check if this result is for a thinking-mode tool
                        if (this.thinkingToolIds.has(block.tool_use_id)) {
                            // Update the thinking message (pass childToolIds for Task results)
                            this.updateThinkingToolResult(block.tool_use_id, resultContent, verifiedFiles, fileLinks, childToolIds, startLine);
                        } else {
                            this.addToolResult({
                                tool_use_id: block.tool_use_id,
                                content: resultContent,
                                verifiedFiles,
                                fileLinks,
                                startLine
                            });
                        }
                    }
                });
            } else if (typeof content === 'string' && content.trim()) {
                // Handle user messages with string content (e.g., <local-command-stderr>)
                // These are synthetic messages from Claude Code representing errors/events
                const stderrMatch = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
                if (stderrMatch) {
                    const errorContent = stderrMatch[1].trim();
                    this.addMessage({
                        role: 'error',
                        content: errorContent,
                        source: 'local-command-stderr'
                    });
                }
                // Handle local command stdout (e.g., /context results)
                const stdoutMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
                if (stdoutMatch) {
                    const outputContent = stdoutMatch[1].trim();
                    // Skip bare "Compacted" — compact_boundary handler shows richer message
                    if (outputContent.toLowerCase().startsWith('compacted')) {
                        debug.log('Skipping redundant "Compacted" stdout (compact_boundary shown)');
                    } else {
                        this.addMessage({
                            role: 'info',
                            content: outputContent,
                            source: 'local-command-stdout'
                        });
                    }
                }
            }
        }

        if (data.type === 'result') {
            // End of response - clear thinking mode and turn state
            this.inThinkingMode = false;
            this.thinkingToolIds.clear();
            this.currentThinkingMsgId = null;
            this.isAgentRunning = false;  // Claude finished

            // Flush any stale running agents (missed result events)
            this._flushStaleAgents();

            // Safety net: if ExitPlanMode was denied by CLI permission system
            // (--dangerously-skip-permissions doesn't bypass permission model changes),
            // force-clear plan mode from the result's permission_denials record.
            if (this.permissionMode === 'plan' && data.permission_denials?.length) {
                const exitDenied = data.permission_denials.some(d => d.tool_name === 'ExitPlanMode');
                if (exitDenied) {
                    debug.log('ExitPlanMode denied by CLI — force-clearing plan mode');
                    this.permissionMode = null;
                    if (this.isActive) {
                        app.updateInputPlaceholder();
                    }
                }
            }

            // Defense-in-depth: catch denials whose mid-stream wording didn't match
            // the regex (e.g. auto mode classifier rejects use different phrasing).
            if (data.permission_denials?.length) {
                const modeKey = window.permissionSettings?.currentLevel || 'dontAsk';
                const modeLabel = window.permissionSettings?.getModeLabel?.(modeKey) || modeKey;
                data.permission_denials.forEach(d => {
                    if (INTERACTIVE_TOOLS.has(d.tool_name)) return;
                    if (this._deniedToolsThisTurn.has(d.tool_name)) return;
                    // Manual card deny: the user chose this — the answered card
                    // + tool error already explain it. The "change the
                    // permission level" mode wording would be wrong here.
                    if (this.findManualDenyCard(d.tool_name, d.tool_use_id)) return;
                    this._deniedToolsThisTurn.add(d.tool_name);
                    this.addMessage({
                        role: 'error',
                        content: S.permissions.deny_explainer
                            .replace('{tool}', d.tool_name)
                            .replace('{details}', summarizeToolInput(d.tool_name, d.tool_input))
                            .replace('{mode}', modeLabel),
                        source: 'permission-denied'
                    });
                });
            }
            this._deniedToolsThisTurn.clear();

            // Only show green "ready" dot for background sessions (not the active one)
            // This tells user "there's new completed work to review in this tab"
            if (!this.isActive) {
                this.isReady = true;
            }
            this.updateTab();  // Update tab indicator immediately
            this._setActivity({ active: false });

            if (data.total_cost_usd) {
                this.totalCost += data.total_cost_usd;
            }
            // Extract token usage from result
            this.extractTokenUsage(data);
            if (this.isActive) app.updateStatus();

            // Update question indicator (scroll-to button) if there's a pending question
            if (this.isActive) {
                app.updateQuestionIndicator();
            }
        }
    },
};

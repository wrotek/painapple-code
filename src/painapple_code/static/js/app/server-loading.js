/**
 * Server-loading mixin — transformServerMessages (maps the server's snake_case
 * message log into the client's camelCase shape, fixing up incomplete tools and
 * emitting extra messages for ExitPlanMode/AskUserQuestion) and
 * loadSessionFromServer (hydrates a session from the server on open/reconnect).
 * Extracted from app.js; applied to App.prototype via Object.assign. Uses `this`
 * (App instance) plus the imports below.
 */
import { CONFIG } from '../config.js';
import { genId } from '../utils.js';
import { Session } from '../session.js';
import { basename } from '../path-utils.js';

export const serverLoadingMethods = {
    // Transform server messages (snake_case) to client format (camelCase)
    // When loading from storage, mark incomplete tools as completed to avoid "Running..." forever
    // Uses flatMap so thinking blocks containing ExitPlanMode/AskUserQuestion can emit extra messages
    transformServerMessages(messages, sessionId) {
        // Check if a user message follows ExitPlanMode (means plan was acted on)
        const hasUserAfterExitPlan = (() => {
            let sawExitPlan = false;
            for (const m of (messages || [])) {
                if (m.role === 'thinking' && (m.tools || []).some(t => (t.toolName || t.tool_name) === 'ExitPlanMode')) {
                    sawExitPlan = true;
                } else if (m.role === 'tool' && (m.tool_name || m.toolName) === 'ExitPlanMode') {
                    sawExitPlan = true;
                } else if (sawExitPlan && m.role === 'user') {
                    return true;
                }
            }
            return false;
        })();

        const allMsgs = messages || [];
        // A question counts as answered ONLY if the user actually submitted an
        // answer for THIS tool call. The server persists that as a role:'user'
        // record stamped with is_question_answer + the answered tool_use_id
        // (ws_chat.py `_handle_tool_answer`). Matching on that id — instead of
        // "any later user message" — is what keeps a still-pending question from
        // being falsely marked "Answered" just because the user later sent an
        // unrelated chat message in the same session.
        const findAnswerRecord = (toolId) => {
            if (!toolId) return null;
            return allMsgs.find(m =>
                m.role === 'user' &&
                (m.is_question_answer || m.isQuestionAnswer) &&
                (m.tool_use_id || m.toolUseId) === toolId
            ) || null;
        };
        return allMsgs.flatMap((msg, idx) => {
            // Ensure all messages have an id
            const baseMsg = {
                ...msg,
                id: msg.id || genId(),
            };

            // Transform user messages - convert server's snake_case to camelCase
            if (msg.role === 'user') {
                const transformed = {
                    ...baseMsg,
                    hasImages: msg.has_images || msg.hasImages || false,
                    imageCount: msg.image_count || msg.imageCount || 0,
                    hasFiles: msg.has_files || msg.hasFiles || false,
                    fileCount: msg.file_count || msg.fileCount || 0,
                };
                // Convert persisted image filenames to thumbnail URLs
                const imageFiles = msg.image_files || msg.imageFiles;
                if (imageFiles && imageFiles.length > 0 && sessionId) {
                    transformed.imageThumbnails = imageFiles.map(f =>
                        `${CONFIG.API_BASE}/api/sessions/${sessionId}/uploads/${encodeURIComponent(f)}`
                    );
                }
                return transformed;
            }

            if (msg.role === 'tool') {
                const toolName = msg.tool_name || msg.toolName;
                const toolId = msg.tool_id || msg.toolId;
                const toolInput = msg.tool_input || msg.toolInput;

                // Convert ExitPlanMode tools to plan_approval for interactive rendering
                // Server stores as role:'tool' but client needs role:'plan_approval' for buttons
                if (toolName === 'ExitPlanMode') {
                    return {
                        ...baseMsg,
                        role: 'plan_approval',
                        toolId,
                        toolName: 'ExitPlanMode',
                        toolInput,
                        planFile: toolInput?.planFile || null,
                        answered: hasUserAfterExitPlan,
                        decision: hasUserAfterExitPlan ? 'approve' : null,
                        timestamp: msg.timestamp || baseMsg.timestamp,
                    };
                }

                // Convert AskUserQuestion tools to question for interactive form rendering
                // Server stores as role:'tool' but client needs role:'question' for form UI
                if (toolName === 'AskUserQuestion') {
                    const answerRec = findAnswerRecord(toolId);
                    const savedAnswers = answerRec?.answers || {};
                    return {
                        ...baseMsg,
                        role: 'question',
                        toolId,
                        toolName: 'AskUserQuestion',
                        questions: toolInput?.questions || [],
                        entries: [{ toolId, questions: toolInput?.questions || [], answers: savedAnswers }],
                        answered: !!answerRec,
                        answers: savedAnswers,
                        timestamp: msg.timestamp || baseMsg.timestamp,
                    };
                }

                // Mark as completed when loading from storage - tools shouldn't show "Running..."
                // after a page refresh since Claude isn't actively running them
                const hasOutput = msg.tool_output || msg.toolOutput;
                const hasError = msg.tool_error || msg.toolError;
                const wasCompleted = msg.tool_completed || msg.toolCompleted;
                return {
                    ...baseMsg,
                    toolName,
                    toolId,
                    toolInput,
                    toolOutput: msg.tool_output || msg.toolOutput || '',
                    toolError: msg.tool_error || msg.toolError || '',
                    // Mark as completed if it was completed OR if we're loading from storage
                    toolCompleted: wasCompleted || hasOutput || hasError || true,
                    toolType: msg.toolType || 'use',
                    startLine: msg.startLine || null,  // Server-parsed line number for Edit tools
                };
            }
            if (msg.role === 'thinking') {
                const tools = (msg.tools || []).map(tool => ({
                    ...tool,
                    toolName: tool.toolName || tool.tool_name || '',
                    toolId: tool.toolId || tool.tool_id || '',
                    toolInput: tool.toolInput || tool.tool_input || {},
                    toolOutput: tool.toolOutput || tool.tool_output || null,
                    // Mark thinking tools as completed when loading from storage
                    toolCompleted: true,
                }));

                // Extract interactive tools from thinking → separate messages
                const exitPlan = tools.find(t => t.toolName === 'ExitPlanMode');
                const askTool = tools.find(t => t.toolName === 'AskUserQuestion');
                let filteredTools = tools;
                const extracted = [];

                if (exitPlan) {
                    filteredTools = filteredTools.filter(t => t.toolName !== 'ExitPlanMode');
                    // Find plan file from Write tools in this thinking block
                    let planFile = null;
                    for (let i = tools.length - 1; i >= 0; i--) {
                        const t = tools[i];
                        if (t.toolName === 'Write' && t.toolInput?.file_path) {
                            const fname = basename(t.toolInput.file_path).toLowerCase();
                            if (fname.includes('plan') || t.toolInput.file_path.includes('.claude/plans/')) {
                                planFile = t.toolInput.file_path;
                                break;
                            }
                        }
                    }
                    // Fallback: use last Write tool (plan may have non-standard name)
                    if (!planFile) {
                        for (let i = tools.length - 1; i >= 0; i--) {
                            const t = tools[i];
                            if (t.toolName === 'Write' && t.toolInput?.file_path) {
                                planFile = t.toolInput.file_path;
                                break;
                            }
                        }
                    }
                    extracted.push({
                        id: genId(),
                        role: 'plan_approval',
                        toolId: exitPlan.toolId,
                        toolName: 'ExitPlanMode',
                        toolInput: exitPlan.toolInput,
                        planFile,
                        answered: hasUserAfterExitPlan,
                        decision: hasUserAfterExitPlan ? 'approve' : null,
                        timestamp: msg.timestamp || baseMsg.timestamp,
                    });
                }

                if (askTool) {
                    filteredTools = filteredTools.filter(t => t.toolName !== 'AskUserQuestion');
                    const questions = askTool.toolInput?.questions || [];
                    const answerRec = findAnswerRecord(askTool.toolId);
                    const savedAnswers = answerRec?.answers || {};
                    extracted.push({
                        id: genId(),
                        role: 'question',
                        toolId: askTool.toolId,
                        toolName: 'AskUserQuestion',
                        questions,
                        entries: [{ toolId: askTool.toolId, questions, answers: savedAnswers }],
                        answered: !!answerRec,
                        answers: savedAnswers,
                        timestamp: msg.timestamp || baseMsg.timestamp,
                    });
                }

                const thinkingMsg = {
                    ...baseMsg,
                    content: msg.content || '',
                    tools: filteredTools,
                };
                return [thinkingMsg, ...extracted];
            }
            return [baseMsg];
        });
    },

    async loadSessionFromServer(storeId, initialMessageLimit = 50, fromWelcome = false, options = {}) {
        const { background = false } = options;
        // Track session for cleanup (could be existing or newly created)
        let sessionToCleanup = null;

        // Check if session already exists locally (to set loading flag)
        let existingSession = this.sessionManager.sessions.find(s => s.storeId === storeId);
        if (existingSession) {
            existingSession.isLoadingFromServer = true;  // Prevent sync race condition
            sessionToCleanup = existingSession;
            // Mark if opened from welcome (for back button)
            if (fromWelcome) {
                existingSession.openedFromWelcome = true;
            }
        }

        try {
            // Step 1: Fetch session metadata (without loading all messages)
            const logsResponse = await fetch(`${CONFIG.API_BASE}/api/sessions/${storeId}/logs`);
            if (!logsResponse.ok) {
                this.activeSession?.addSystemLog(`Session not found: ${storeId}`, 'error');
                return false;
            }

            const logsData = await logsResponse.json();
            const meta = logsData.meta || {};
            const totalMessageCount = logsData.files?.messages?.lines || 0;
            const totalUserPromptCount = logsData.files?.messages?.user_lines || 0;

            // Step 2: Fetch only the last N messages (lazy loading)
            let transformedMessages = [];
            let lastTimestamp = null;
            let hasMoreMessages = false;

            if (totalMessageCount > 0) {
                const messagesResponse = await fetch(
                    `${CONFIG.API_BASE}/api/sessions/${storeId}/logs/messages?sort=desc&limit=${initialMessageLimit}`
                );
                if (messagesResponse.ok) {
                    const messagesData = await messagesResponse.json();
                    // Reverse so oldest is first (for display order)
                    transformedMessages = this.transformServerMessages(
                        (messagesData.messages || []).reverse(), storeId
                    );
                    hasMoreMessages = messagesData.has_more || false;

                    // Find the latest timestamp from loaded messages
                    if (transformedMessages.length > 0) {
                        lastTimestamp = transformedMessages.reduce((max, msg) =>
                            msg.timestamp && msg.timestamp > max ? msg.timestamp : max,
                            ''
                        );
                    }
                }
            }

            // Check if we already have this session locally
            let session = this.sessionManager.sessions.find(s => s.storeId === storeId);

            if (session) {
                // Update existing session with server data
                session.messages = transformedMessages;
                session.totalCost = meta.total_cost || 0;
                session.model = meta.model;
                session.providerSessionId = meta.provider_session_id;
                // Engine identity + pref caches from meta — first paint is
                // engine-correct without waiting for the WS connect.
                session.provider = meta.provider || session.provider;
                session.preferredModel = meta.preferred_model ?? session.preferredModel;
                session.effortLevel = meta.effort_level || session.effortLevel;
                session.tokenProfileName = meta.token_profile ?? session.tokenProfileName;
                session.slashCommands = meta.slash_commands || [];
                session.lastSyncTimestamp = lastTimestamp;
                session.hasMoreMessages = hasMoreMessages;
                session.totalMessageCount = totalMessageCount;
                session.totalUserPromptCount = totalUserPromptCount;
            } else {
                // Create new local session from server data
                // Use saved welcome tab position so new session replaces it visually
                const atIndex = this._welcomeReplaceIndex;
                delete this._welcomeReplaceIndex;
                session = this.sessionManager.create({
                    name: meta.name,
                    cwd: meta.cwd,
                    storeId: storeId,
                    providerSessionId: meta.provider_session_id,
                    provider: meta.provider || null,
                    preferredModel: meta.preferred_model ?? null,
                    effortLevel: meta.effort_level || null,
                    tokenProfileName: meta.token_profile ?? null,
                    messages: transformedMessages,
                    totalCost: meta.total_cost || 0,
                    model: meta.model,
                    slashCommands: meta.slash_commands || [],
                    createdAt: meta.created_at,
                    lastActivity: meta.last_activity,
                    wasConnected: true,
                    lastSyncTimestamp: lastTimestamp,
                    hasMoreMessages: hasMoreMessages,
                    totalMessageCount: totalMessageCount,
                    totalUserPromptCount: totalUserPromptCount,
                    atIndex,
                });
                // Set flag on new session to prevent sync race condition
                if (session) {
                    session.isLoadingFromServer = true;
                    sessionToCleanup = session;
                    // Mark if opened from welcome (for back button)
                    if (fromWelcome) {
                        session.openedFromWelcome = true;
                    }
                }
            }

            if (session) {
                // Ensure messages are sorted and deduplicated
                session.sortMessagesByTimestamp();
                session.deduplicateMessages();
                session.adoptContextFromMessages();

                // Mark load time to prevent immediate load-more trigger (debounce)
                session._lastLoadTime = Date.now();

                // Save session after all modifications (fixes persistence on quick refresh)
                this.sessionManager.saveSessions();

                // Switch to the session unless opened in background
                if (!background) {
                    this.switchSession(session);
                    // Auto-connect if session has a cwd
                    if (session.cwd && session.status === 'disconnected') {
                        session.connect();
                    }
                }
                // Re-render tabs to show the new session tab
                this.tabCtrl.renderTabs();
                return true;
            }
        } catch (error) {
            console.error('Failed to load session from server:', error);
            this.activeSession?.addSystemLog(`Failed to load session: ${error.message}`, 'error');
        } finally {
            // Clear loading flag on whichever session we were tracking
            if (sessionToCleanup) {
                sessionToCleanup.isLoadingFromServer = false;
            }
        }
        return false;
    },
};

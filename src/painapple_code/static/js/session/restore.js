/**
 * Constructor message restoration — rebuilds the messages array from a
 * persisted (localStorage / server) snapshot. Three jobs:
 *   1. Mark in-flight tools as completed so the UI doesn't show "Running…"
 *      after a refresh.
 *   2. Promote standalone AskUserQuestion tool messages into role=question
 *      so the interactive form re-renders.
 *   3. Extract ExitPlanMode + AskUserQuestion tools that landed inside a
 *      thinking block into their own approval / question messages, so they
 *      keep working after restore.
 *
 * Pure function — no imports from session.js, takes raw saved messages and
 * the (still-being-built) constructor options, returns the new array.
 */

import { genId } from '../utils.js';
import { basename } from '../path-utils.js';

export function restoreMessages(savedMessages, options) {
    const allMsgs = savedMessages || [];

    // A question counts as answered ONLY if the user actually submitted an
    // answer for THIS tool call — the server persists that as a role:'user'
    // record stamped with is_question_answer + the answered tool_use_id. Matching
    // on that id (not "any later user message") keeps a still-pending question
    // from being falsely marked "Answered" after the user later sends an
    // unrelated message in the same session.
    const findAnswerRecord = (toolId) => {
        if (!toolId) return null;
        return allMsgs.find(m =>
            m.role === 'user' &&
            (m.is_question_answer || m.isQuestionAnswer) &&
            (m.tool_use_id || m.toolUseId) === toolId
        ) || null;
    };

    return allMsgs.flatMap((msg, idx) => {
        if (msg.role === 'tool' && !msg.toolCompleted) {
            return { ...msg, toolCompleted: true };
        }
        // Convert standalone AskUserQuestion tool messages to question format
        // (stored by server as role=tool, needs role=question for interactive form)
        if (msg.role === 'tool' && (msg.toolName || msg.tool_name) === 'AskUserQuestion') {
            const rawQ = (msg.toolInput || msg.tool_input)?.questions;
            const questions = Array.isArray(rawQ) ? rawQ : [];
            const toolId = msg.toolId || msg.tool_id;
            const answerRec = findAnswerRecord(toolId);
            const savedAnswers = answerRec?.answers || {};
            return {
                ...msg,
                role: 'question',
                toolName: 'AskUserQuestion',
                toolId,
                questions,
                entries: [{ toolId, questions, answers: savedAnswers }],
                answered: !!answerRec,
                answers: savedAnswers,
                comment: answerRec?.comment || '',
                activeTab: 0,
            };
        }
        if (msg.role === 'thinking' && msg.tools) {
            const tools = msg.tools.map(t => ({ ...t, toolCompleted: true }));
            const exitPlan = tools.find(t => t.toolName === 'ExitPlanMode');
            const askTool = tools.find(t => t.toolName === 'AskUserQuestion');

            if (exitPlan || askTool) {
                const extracted = [];
                let filteredTools = tools;

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
                    const stillInPlanMode = options.permissionMode === 'plan';
                    extracted.push({
                        id: genId(),
                        role: 'plan_approval',
                        toolId: exitPlan.toolId,
                        toolName: 'ExitPlanMode',
                        toolInput: exitPlan.toolInput,
                        planFile,
                        answered: !stillInPlanMode,
                        decision: stillInPlanMode ? null : 'approve',
                        timestamp: msg.timestamp,
                    });
                }

                if (askTool) {
                    filteredTools = filteredTools.filter(t => t.toolName !== 'AskUserQuestion');
                    const rawAskQ = askTool.toolInput?.questions;
                    const questions = Array.isArray(rawAskQ) ? rawAskQ : [];
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
                        comment: answerRec?.comment || '',
                        activeTab: 0,
                        timestamp: msg.timestamp,
                    });
                }

                return [{ ...msg, tools: filteredTools }, ...extracted];
            }
            return { ...msg, tools };
        }
        return msg;
    });
}

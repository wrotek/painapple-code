/**
 * Input & event-wiring mixin — initEventListeners (wires every app-level DOM /
 * keyboard / drag-drop / resize listener), the input-history + draft helpers,
 * the slash/shell/bang command dispatch delegators, and sendInNewSession /
 * sendMessage. Extracted from app.js; applied to App.prototype via
 * Object.assign. Uses `this` (App instance) plus the imports below.
 */
import S from '../strings.js';
import { HAS_PHYSICAL_KEYBOARD } from '../config.js';
import { TerminalWidget, WidgetManager } from '../widget-system/init.js';
import { ImagePreviewWidget } from '../widgets/index.js';
import { OpenDialog } from '../open-dialog.js';
import { effortSettings } from '../effort-settings.js';
import { Stash } from '../stash.js';
import { bgTaskTracker } from '../background-tasks.js';
import { clearSavedWelcomeState } from '../welcome.js';
import * as PromptFavorites from '../prompt-favorites.js';

export const inputEventMethods = {
    initEventListeners() {
        // New tab button - click for new session, long-press for menu
        this.els.newTabBtn.addEventListener('click', () => this.createSession());
        this.initNewTabLongPress();

        // Send button (delegates to InputHandler)
        this.els.sendBtn.addEventListener('click', () => this.inputHandler?.handleInput());

        // Follow-up button (queues message during a working turn — same handler as send)
        this.els.followupBtn.addEventListener('click', () => this.inputHandler?.handleInput());

        // Stop button
        this.els.stopBtn.addEventListener('click', () => this.stopClaude());

        // Upload button - accepts all files, routes by type
        this.els.uploadBtn.addEventListener('click', () => this.openFileUpload());

        // Toolbar buttons (rail buttons handled in initLeftRailButtons)
        bgTaskTracker.onStateChange(() => this._updateBgTasksBadge());
        this.els.promptHistoryBtn?.addEventListener('click', () => WidgetManager.toggle('prompt-explorer'));
        this.els.uploadsBtn?.addEventListener('click', () => WidgetManager.toggle('uploads'));
        this.els.discussionBtn?.addEventListener('click', () => WidgetManager.toggle('discussion'));
        this.els.discussionBtn?.addEventListener('touchend', (e) => {
            e.preventDefault();
            WidgetManager.toggle('discussion');
        }, { passive: false });

        // Autocomplete trigger buttons — insert symbol + fire input event
        this.els.fileMentionBtn?.addEventListener('click', () => this.triggerFileMention());
        this.els.snippetsBtn?.addEventListener('click', () => this.triggerSnippets());
        this.els.slashCmdBtn?.addEventListener('click', () => this.triggerSlashCommand());
        this.els.skillsBtn?.addEventListener('click', () => this.triggerSkills());

        // Message input events are handled by InputHandler module

        // Confirm dialog
        this.els.confirmCancel.addEventListener('click', () => this.hideConfirmDialog());
        this.els.confirmCreate.addEventListener('click', () => this.createDirectoryAndConnect());
        this.els.confirmDialog.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.createDirectoryAndConnect();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.hideConfirmDialog();
            }
        });

        // Settings & Help live on the rail (initLeftRailButtons)
        this.initLeftRailButtons();
        this.initRailDrawer();

        // Initialize font size on startup
        this.applyFontScale();
        // Apply per-instance identity (accent color, badge, stripe)
        this.applyInstanceConfig();
        this.els.modalClose.addEventListener('click', () => this.hideModal());
        this.els.modalOverlay.addEventListener('click', (e) => {
            if (e.target === this.els.modalOverlay) this.hideModal();
        });

        // Auto-resize textarea (respects user's custom min-height)
        // Also sync highlight backdrop for thinking keywords
        // Also dismiss back-to-sessions pill when user starts typing
        this.els.messageInput.addEventListener('input', () => {
            this.autoResizeInput();
            this.syncInputHighlightBackdrop();
            // Dismiss pill when user starts typing (commits to this session)
            if (this.els.messageInput.value.length > 0 && this.chatCtrl?.canGoBackToSessions()) {
                this.chatCtrl._dismissBackToSessionsPill();
            }
        });

        // Sync scroll position of highlight backdrop when textarea scrolls
        this.els.messageInput.addEventListener('scroll', () => {
            const backdrop = document.getElementById('input-highlight-backdrop');
            if (backdrop) {
                backdrop.scrollTop = this.els.messageInput.scrollTop;
            }
        });

        // Delegated click handler for file preview buttons and image thumbnails in messages
        this.els.messages.addEventListener('click', (e) => {
            // Handle file preview buttons
            const previewBtn = e.target.closest('[data-preview-file]');
            if (previewBtn) {
                e.preventDefault();
                const filePath = previewBtn.dataset.previewFile;
                if (filePath) {
                    this.previewFile(filePath);
                }
                return;
            }

            // Handle tool-result image clicks (Read/Write/thinking tool images)
            const toolImg = e.target.closest('.read-image-content img, .write-image-content img, .tt-image-thumb img');
            if (toolImg) {
                e.preventDefault();
                e.stopPropagation();
                ImagePreviewWidget.show(toolImg.src);
                return;
            }

            // Handle image thumbnail clicks in sent messages
            const imageThumb = e.target.closest('.message-image-thumb');
            if (imageThumb) {
                e.preventDefault();
                const src = imageThumb.dataset.src || imageThumb.querySelector('img')?.src;
                if (src) {
                    ImagePreviewWidget.show(src);
                }
            }
        });


        // Scroll tracking handled by ScrollManager (initialized in initAutocomplete)

        // Focus input on background click (button click handled by ScrollManager)
        // On welcome screen: click background to BLUR (for type-anywhere)
        // On chat screen: click background to FOCUS
        this.els.messagesContainer.addEventListener('click', (e) => {
            if (e.target.closest('.new-messages-btn')) {
                // Handled by ScrollManager's button
                return;
            }

            // Check if we're on welcome screen
            const isWelcome = this.chatCtrl?.isWelcomeShowing();

            if (isWelcome) {
                // Welcome screen: click on non-interactive areas to BLUR input (for type-anywhere)
                const isWelcomeInteractive = e.target.closest(
                    'button, a, input, textarea, [data-action], [data-session-id], ' +
                    '.session-family, .family-branch-item, .session-preview, ' +
                    '.project-filter-chip, .context-menu, [role="button"]'
                );
                if (!isWelcomeInteractive && document.activeElement === this.els.messageInput) {
                    this.els.messageInput.blur();
                }
            } else {
                // Chat screen: click background to FOCUS input
                // Exclude messages entirely (allows text selection inside messages)
                const isInteractive = e.target.closest('.message, .message-history-notice, .thinking-group, .chat-nav, .session-preview-overlay, .session-preview-sheet, .session-context-overlay, .session-context-menu');
                if (!isInteractive && HAS_PHYSICAL_KEYBOARD) {
                    this.focusInput();
                }
            }
        });

        // Tool output expand buttons in thinking blocks (event delegation)
        this.els.messages.addEventListener('click', (e) => {
            const btn = e.target.closest('.tool-output-expand-btn');
            if (btn) {
                e.stopPropagation(); // Don't toggle thinking step
                const wrapper = btn.closest('.thinking-msg-tool-output-wrapper');
                if (wrapper) {
                    const isExpanded = wrapper.classList.toggle('expanded');
                    btn.textContent = isExpanded ? btn.dataset.expanded : btn.dataset.collapsed;

                    // Also expand/contract the parent step-detail container
                    const stepDetail = wrapper.closest('.thinking-step-detail');
                    if (stepDetail) {
                        // Check if any tool outputs are still expanded
                        const hasExpandedOutputs = stepDetail.querySelector('.thinking-msg-tool-output-wrapper.expanded');
                        stepDetail.classList.toggle('has-expanded-output', !!hasExpandedOutputs);
                    }
                }
            }
        });

        // Tool header click → collapse/expand (same as gutter chevron)
        this.els.messages.addEventListener('click', (e) => {
            // Skip clicks on interactive elements inside headers
            if (e.target.closest('button, a, input, .bash-cmd-wrapper')) return;
            const header = e.target.closest('.read-header, .bash-header, .grep-header, .glob-header, .write-header, .edit-diff-header, .webfetch-header');
            if (!header) return;
            const wrapper = header.closest('.tool-block-wrapper, .thinking-tool-card');
            if (!wrapper) return;
            const toolId = wrapper.dataset.toolId;
            if (!toolId) return;
            if (wrapper.classList.contains('thinking-tool-card')) {
                this.toggleToolCollapse(toolId);
            } else {
                this.toggleNormalToolCollapse(toolId);
            }
        });

        // "N more lines" expand button on a collapsed tool card → also uncollapse
        // the card. The inline onclick only toggles the block's .expanded class,
        // which stays invisible under the card-level .tool-collapsed — without
        // this the user has to hit the gutter chevron as a second step.
        this.els.messages.addEventListener('click', (e) => {
            const btn = e.target.closest('.diff-expand-btn, .read-expand-btn, .bash-expand-btn, .write-expand-btn, .webfetch-expand-btn');
            if (!btn) return;
            const card = btn.closest('.thinking-tool-card.tool-collapsed, .tool-block-wrapper.tool-collapsed');
            if (!card) return;
            card.classList.remove('tool-collapsed');
            // The inline onclick already toggled the block; if the label got
            // out of sync while hidden, force expanded so one click always
            // reveals the full content.
            const block = btn.closest('.edit-diff, .read-block, .bash-block, .write-block, .webfetch-block');
            if (block && !block.classList.contains('expanded')) {
                block.classList.add('expanded');
                btn.textContent = '▲ Collapse';
            }
        });

        // Window resize - check gutter space for thinking sections and tool groups (debounced)
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.thinkingCtrl.checkAllGutterSpace();
                this.chatCtrl.checkAllToolGroupGutterSpace();
                // Refit all terminals (floating + tabs) to use new window dimensions
                TerminalWidget.fit();
            }, 150);
        });
    },

    // ═══════════════════════════════════════════════════════════════
    // INPUT HANDLING (delegated to InputHandler module)
    // ═══════════════════════════════════════════════════════════════

    /** @deprecated Use inputHandler.handleInput() */
    handleInput() {
        this.inputHandler?.handleInput();
    },

    /** @deprecated Use inputHandler.getHistory() */
    getInputHistory() {
        return this.inputHandler?.getHistory() || [];
    },

    /** @deprecated Use inputHandler.addToHistory() */
    addToInputHistory(content) {
        this.inputHandler?.addToHistory(content);
    },

    /** @deprecated Use inputHandler.getDraftKey() */
    getDraftKey() {
        return this.inputHandler?.getDraftKey() || 'claude-draft:default';
    },

    /** @deprecated Use inputHandler.saveDraft() */
    saveDraft(text) {
        this.inputHandler?.saveDraft(text);
    },

    /** @deprecated Use inputHandler.loadDraft() */
    loadDraft() {
        return this.inputHandler?.loadDraft() || '';
    },

    /** @deprecated Use inputHandler.clearDraft() */
    clearDraft() {
        this.inputHandler?.clearDraft();
    },

    /** @deprecated Use inputHandler.restoreDraft() */
    restoreDraft() {
        this.inputHandler?.restoreDraft();
    },

    /** @delegate CommandExecutor */
    handleSlashCommand(cmd) { this.commandExec.handleSlashCommand(cmd); },

    /** @delegate CommandExecutor */
    async executeCustomCommand(customCmd, inputText) {
        return this.commandExec.executeCustomCommand(customCmd, inputText);
    },

    /** @delegate CommandExecutor */
    async executeShellCommand(shellCmd) {
        return this.commandExec.executeShellCommand(shellCmd);
    },

    /** @delegate CommandExecutor */
    async handleBangCommand(cmd) {
        return this.commandExec.handleBangCommand(cmd);
    },

    /**
     * Send message in a brand-new session (Ctrl+Shift+Enter)
     * Delegates to cloneSession which handles CWD + optional prompt.
     */
    sendInNewSession(content) {
        // cloneSession needs activeSession.cwd — no project picked yet means
        // there's nothing to clone into.
        if (!this.activeSession?.cwd) {
            this.activeSession?.addSystemLog(S.errors.select_project);
            return;
        }
        this.cloneSession(content);
    },

    sendMessage(content, options = {}) {
        if (!this.activeSession) return;

        // Check if welcome screen is showing - route appropriately
        if (this.chatCtrl.isWelcomeShowing()) {
            // If already in task mode, don't re-enter - user should pick an option
            if (this.chatCtrl.isWelcomeInTaskMode()) {
                return;
            }

            // Start a new session with this message
            const cwd = this.activeSession?.cwd;
            if (!cwd) {
                // No project selected - store message and prompt for project
                this._pendingWelcomeMessage = content;
                this.els.connectionBar.classList.add('visible');
                OpenDialog.show();
                this.activeSession.addSystemLog(S.errors.select_project_send);
                return;
            }

            // Has CWD - set on session and flip to chat view so the message
            // sends through normal flow (connect + send).
            this.activeSession.cwd = cwd;
            this.tabCtrl.switchToSession(this.activeSession);
            // Fall through to normal message sending below
        }

        // Save to persistent per-project history
        this.addToInputHistory(content);

        // Build message content - include buffered bang outputs but don't show them in UI
        let messageToSend = content;
        const pendingOutputs = this.activeSession.pendingBangOutputs;

        if (pendingOutputs && pendingOutputs.length > 0) {
            // Format all buffered command outputs
            const commandsBlock = pendingOutputs.map(bang => {
                const outputPreview = bang.output.length > 3000
                    ? bang.output.slice(0, 3000) + '\n...(output truncated)'
                    : bang.output;
                return `$ ${bang.command}\n${outputPreview}\nExit code: ${bang.exitCode}`;
            }).join('\n\n');

            // Prepend to message (this goes to Claude, not shown in UI)
            messageToSend = `I ran these commands:\n\`\`\`\n${commandsBlock}\n\`\`\`\n\n${content}`;

            // Clear pending outputs
            this.activeSession.pendingBangOutputs = [];
            this.els.messageInput.placeholder = S.ui.input.placeholder;
        }

        // Collect pending files and prepend paths to message
        const files = [...this.pendingFiles];
        const hasFiles = files.length > 0;

        if (hasFiles) {
            // Build file references - Claude will read these via Read tool
            const fileRefs = files.map(f => `Uploaded file: ${f.path}`).join('\n');
            messageToSend = `${fileRefs}\n\n${messageToSend}`;
        }

        // Clear pending files
        this.clearPendingFiles();

        // Collect stash items before marking sent (to store with message for display)
        // Only attach if stash is not paused
        let stashRefs = null;
        let sentStashIds = null;
        if (Stash.hasEnabled() && !Stash.isPaused()) {
            // Save compact version of stash items for message display
            stashRefs = Stash.getEnabled().map(item => ({
                type: item.type,
                selectedText: item.selectedText?.slice(0, 300), // Truncate for storage
                note: item.note || '',
                filePath: item.filePath,
                messageIndex: item.messageIndex,
                markerIndex: item.markerIndex ?? null
            }));
            const stashContext = Stash.formatForPrompt();
            messageToSend = `${stashContext}${messageToSend}`;
            // Mark sent after the user message is stored (below) — items move
            // to stash history instead of being deleted
            sentStashIds = Stash.getEnabled().map(item => item.id);
        }

        // Collect pending images
        const images = this.pendingImages.map(img => img.imageData);
        const hasImages = images.length > 0;

        // Create data URIs for thumbnails (to display in sent messages)
        const imageThumbnails = this.pendingImages.map(img => {
            const { media_type, data } = img.imageData.source;
            return `data:${media_type};base64,${data}`;
        });

        // Auto-revise pending plan approvals when user sends a message
        // (sending a new prompt without clicking Approve implicitly revises)
        const pendingPlanApproval = this.activeSession.messages.findLast(
            m => m.role === 'plan_approval' && !m.answered
        );
        if (pendingPlanApproval) {
            pendingPlanApproval.answered = true;
            pendingPlanApproval.decision = 'revise';

            const el = document.getElementById(`msg-${pendingPlanApproval.id}`);
            if (el) {
                const newEl = this.chatCtrl.createMessageElement(pendingPlanApproval);
                el.replaceWith(newEl);
            }

            this.activeSession.pendingQuestionId = null;
            this.activeSession.updateTab();
            this.updateQuestionIndicator();
        }

        // Auto-dismiss pending AskUserQuestion when user sends a text message
        // (user chose to reply with text instead of using the question form).
        // Mark it `skipped` (not just `answered`) so the card reads "Skipped"
        // rather than implying options were chosen — mirrors `ignored`.
        const pendingQuestion = this.activeSession.messages.findLast(
            m => m.role === 'question' && !m.answered
        );
        if (pendingQuestion) {
            pendingQuestion.answered = true;
            pendingQuestion.skipped = true;

            const el = document.getElementById(`msg-${pendingQuestion.id}`);
            if (el) {
                const newEl = this.chatCtrl.createMessageElement(pendingQuestion);
                el.replaceWith(newEl);
            }

            this.activeSession.pendingQuestionId = null;
            this.activeSession.updateTab();
            this.updateQuestionIndicator();
        }

        // Store message with raw content + attachment metadata
        // The suffix "[X images attached]" is added at render time, not stored
        // This ensures deduplication works when syncing from server
        const isInPlanMode = this.activeSession?.isInPlanMode;
        // See note above peekEffectiveLevel call in the sendMessage path.
        const effortLevel = effortSettings.peekEffectiveLevel();
        const storedUserMsg = this.activeSession.addMessage({
            role: 'user',
            content: content,
            hasImages,
            imageCount: images.length,
            imageThumbnails: hasImages ? imageThumbnails : undefined,
            hasFiles,
            fileCount: files.length,
            hasRefs: stashRefs && stashRefs.length > 0,
            refCount: stashRefs?.length || 0,
            stashRefs: stashRefs,
            planMode: isInPlanMode || undefined,  // Mark if sent in plan mode
            effort_level: effortLevel !== 'high' ? effortLevel : undefined,
        });

        // Move attached stash items to history (was: delete on send).
        // sentAt = the message's own timestamp so "go to message" can
        // exact-match it via chatCtrl.scrollToMessage.
        if (sentStashIds && sentStashIds.length > 0) {
            Stash.markSent(sentStashIds, {
                messageId: storedUserMsg?.id || null,
                sentAt: storedUserMsg?.timestamp || null,
                sessionId: this.activeSession.storeId || this.activeSession.id || null,
            });
        }

        // Clear "back to sessions" state - user committed to this session
        if (this.activeSession.openedFromWelcome) {
            this.activeSession.openedFromWelcome = false;
            clearSavedWelcomeState();
            this.chatCtrl?._hideBackToSessionsPill();
        }

        // User sent a message - force scroll to show it (regardless of scroll position)
        this.scrollToBottomForce();

        // Clear pending images and saved upload metadata
        this.clearPendingImages();
        if (this.activeSession) {
            this.activeSession._savedUploadImages = [];
            this.activeSession._savedUploadFiles = [];
        }

        // Build options for server-side storage
        const sendOptions = {};
        if (stashRefs && stashRefs.length > 0) {
            sendOptions.stashRefs = stashRefs;
            sendOptions.displayContent = content;  // Original content without stash prefix
        }
        if (isInPlanMode) {
            sendOptions.planMode = true;
        }
        // Mark as favorite if user toggled the heart button
        if (PromptFavorites.shouldMarkAsFavorite()) {
            sendOptions.markAsFavorite = true;
            PromptFavorites.reset();  // Reset for next prompt
        }

        if (this.activeSession.status !== 'connected') {
            this.activeSession.connect();
            // Queue the message to send after connection
            const checkConnection = setInterval(() => {
                if (this.activeSession.status === 'connected') {
                    clearInterval(checkConnection);
                    this.activeSession.sendWithImages(messageToSend, images, sendOptions);
                }
            }, 100);
            setTimeout(() => clearInterval(checkConnection), 10000);
            return;
        }

        this.activeSession.sendWithImages(messageToSend, images, sendOptions);
    },
};

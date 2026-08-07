/**
 * CommandExecutor - Handles slash commands, bang commands, and custom commands
 */

import { CONFIG, COMMANDS } from './config.js';
import { Storage } from './utils.js';
import { getCommandStore, CommandType } from './command-store.js';

export class CommandExecutor {
    constructor(ctx) {
        this.ctx = ctx;
    }

    get app() {
        return this.ctx._app;
    }

    get activeSession() {
        return this.ctx.session;
    }

    /**
     * Handle a slash command
     * @param {string} cmd - Full command string including /
     */
    handleSlashCommand(cmd) {
        const parts = cmd.split(' ');
        const cmdName = parts[0];
        const inputText = parts.slice(1).join(' ');

        // 1. Check built-in commands first
        const command = COMMANDS.find(c => c.cmd === cmdName);
        if (command && this.app[command.action]) {
            // Pass arguments to commands that accept them
            if (command.hasArgs) {
                this.app[command.action](inputText);
            } else {
                this.app[command.action]();
            }
            return;
        }

        // 2. Check custom commands from CommandStore
        const commandStore = getCommandStore();
        const projectPath = this.activeSession?.cwd || this.app.cwd || null;
        const customCmd = commandStore.getCommand(cmdName, projectPath);

        if (customCmd) {
            this.executeCustomCommand(customCmd, inputText);
            return;
        }

        // 3. Check if it's a Claude command - if so, send to Claude
        const agentCmd = this.app.autocomplete?.agentCommands?.find(c => c.cmd === cmdName);
        if (agentCmd || cmdName.startsWith('/')) {
            // Send to Claude as a regular message
            this.app.sendMessage(cmd);
        } else {
            this.activeSession?.addSystemLog(`Unknown command: ${cmd}`);
        }
    }

    /**
     * Execute a custom command from CommandStore
     * @param {Object} customCmd - Command object from CommandStore
     * @param {string} inputText - Text after the command name
     */
    async executeCustomCommand(customCmd, inputText) {
        const commandStore = getCommandStore();
        const context = {
            input: inputText,
            cwd: this.activeSession?.cwd || this.app.cwd || '',
            session: this.activeSession?.id || '',
        };

        if (customCmd.type === CommandType.PROMPT) {
            // Expand variables and send as message to Claude
            const expanded = commandStore.expandVariables(customCmd.prompt, context);
            this.app.sendMessage(expanded);
        } else if (customCmd.type === CommandType.SHELL) {
            // Expand variables and execute as shell command
            const expanded = commandStore.expandVariables(customCmd.shell, context);
            await this.executeShellCommand(expanded);
        }
    }

    /**
     * Execute a shell command (shared logic for bang commands and custom shell commands)
     * @param {string} shellCmd - The shell command to execute
     * @param {Object} options - Options for execution
     * @param {boolean} options.saveToRecent - Whether to save to recent commands (default: false)
     * @param {string} options.toolType - Type of tool block to show ('shell' or 'bang')
     */
    async executeShellCommand(shellCmd, options = {}) {
        const { saveToRecent = false, toolType = 'shell' } = options;

        if (!shellCmd.trim()) return;
        if (!this.activeSession) return;

        const cwd = this.activeSession.cwd || '.';

        // Save to recent commands if requested
        if (saveToRecent) {
            const recent = Storage.get('recent-shell', []);
            const filtered = recent.filter(c => c !== shellCmd);
            filtered.unshift(shellCmd);
            Storage.set('recent-shell', filtered.slice(0, 10));
        }

        try {
            const response = await fetch(
                `${CONFIG.API_BASE}/api/exec`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: shellCmd, cwd }),
                }
            );
            const data = await response.json();

            if (!response.ok) {
                this.activeSession.addSystemLog(`Error: ${data.detail}`, 'error');
                return;
            }

            // Show output in UI as a tool block
            const output = (data.stdout || data.stderr || '(no output)').trim();
            this.activeSession.addMessage({
                role: 'tool',
                toolType: toolType,
                toolName: 'Shell',
                toolInput: { command: shellCmd },
                toolOutput: output.slice(0, 3000) + (output.length > 3000 ? '\n...(truncated)' : ''),
                toolError: data.exit_code !== 0 ? `Exit code: ${data.exit_code}` : null
            });

            // Add to pending outputs for next Claude message
            if (!this.activeSession.pendingBangOutputs) {
                this.activeSession.pendingBangOutputs = [];
            }
            this.activeSession.pendingBangOutputs.push({
                command: shellCmd,
                output: output.slice(0, 3000),
                exitCode: data.exit_code
            });

            // Update input placeholder to show buffered commands (for bang commands)
            if (toolType === 'bang') {
                const count = this.activeSession.pendingBangOutputs.length;
                const input = this.app.els?.messageInput;
                if (input) {
                    input.placeholder = `${count} command${count > 1 ? 's' : ''} buffered. Type message and press Enter...`;
                }
            }

        } catch (e) {
            console.error('Shell execution error:', e);
            this.activeSession.addSystemLog(`Failed to execute: ${e.message}`, 'error');
        }
    }

    /**
     * Handle a bang command (! prefix)
     * @param {string} cmd - Full command string including !
     */
    async handleBangCommand(cmd) {
        const shellCmd = cmd.slice(1).trim();
        if (!shellCmd) return;
        if (!this.activeSession) return;

        await this.executeShellCommand(shellCmd, {
            saveToRecent: true,
            toolType: 'bang'
        });
    }
}

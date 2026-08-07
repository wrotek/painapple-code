/**
 * Custom command storage and management
 * Handles user-defined commands with localStorage persistence
 */

import { Storage } from './utils.js';
import { debug } from './config.js';

const STORAGE_KEY = 'claude-code-custom-commands';
const STORAGE_VERSION = 1;

/**
 * Command types
 */
export const CommandType = {
    PROMPT: 'prompt',   // Send expanded prompt to Claude
    SHELL: 'shell',     // Execute shell command via /api/exec
    COMPOSITE: 'composite', // Chain of actions (future)
};

/**
 * Command scope
 */
export const CommandScope = {
    GLOBAL: 'global',   // Available in all projects
    PROJECT: 'project', // Only in specific project
};

/**
 * Generate unique command ID
 */
const genCommandId = () => 'cmd_' + Math.random().toString(36).substr(2, 9);

/**
 * CommandStore - Manages custom commands
 */
export class CommandStore {
    constructor() {
        this.data = this.load();
        debug.log('CommandStore initialized:', this.data);
    }

    /**
     * Load commands from localStorage
     */
    load() {
        const stored = Storage.get(STORAGE_KEY);
        if (stored && stored.version === STORAGE_VERSION) {
            return stored;
        }
        // Initialize or migrate
        return {
            version: STORAGE_VERSION,
            global: [],
            projects: {},
        };
    }

    /**
     * Save commands to localStorage
     */
    save() {
        Storage.set(STORAGE_KEY, this.data);
        debug.log('CommandStore saved');
    }

    /**
     * Get all commands for current context
     * @param {string|null} projectPath - Current working directory
     * @param {boolean} includeDisabled - Include disabled commands
     * @returns {Array} Combined global + project commands
     */
    getCommands(projectPath = null, includeDisabled = false) {
        const commands = [];

        // Add global commands
        for (const cmd of this.data.global) {
            if (includeDisabled || cmd.enabled !== false) {
                commands.push({ ...cmd, scope: CommandScope.GLOBAL });
            }
        }

        // Add project-specific commands
        if (projectPath && this.data.projects[projectPath]) {
            for (const cmd of this.data.projects[projectPath]) {
                if (includeDisabled || cmd.enabled !== false) {
                    commands.push({ ...cmd, scope: CommandScope.PROJECT, projectPath });
                }
            }
        }

        return commands;
    }

    /**
     * Get a specific command by name
     * @param {string} cmdName - Command name (with /)
     * @param {string|null} projectPath - Current working directory
     * @returns {Object|null} Command object or null
     */
    getCommand(cmdName, projectPath = null) {
        // Check project commands first (higher priority)
        if (projectPath && this.data.projects[projectPath]) {
            const projectCmd = this.data.projects[projectPath].find(c => c.cmd === cmdName);
            if (projectCmd && projectCmd.enabled !== false) {
                return { ...projectCmd, scope: CommandScope.PROJECT, projectPath };
            }
        }

        // Check global commands
        const globalCmd = this.data.global.find(c => c.cmd === cmdName);
        if (globalCmd && globalCmd.enabled !== false) {
            return { ...globalCmd, scope: CommandScope.GLOBAL };
        }

        return null;
    }

    /**
     * Add a new command
     * @param {Object} command - Command definition
     * @param {string} scope - 'global' or 'project'
     * @param {string|null} projectPath - Project path if scope is 'project'
     * @returns {Object} Created command with ID
     */
    addCommand(command, scope = CommandScope.GLOBAL, projectPath = null) {
        const now = new Date().toISOString();
        const newCommand = {
            id: genCommandId(),
            cmd: command.cmd.startsWith('/') ? command.cmd : '/' + command.cmd,
            desc: command.desc || '',
            type: command.type || CommandType.PROMPT,
            enabled: true,
            createdAt: now,
            updatedAt: now,
            // Type-specific fields
            ...(command.type === CommandType.PROMPT && { prompt: command.prompt || '' }),
            ...(command.type === CommandType.SHELL && { shell: command.shell || '' }),
            ...(command.type === CommandType.COMPOSITE && { steps: command.steps || [] }),
        };

        if (scope === CommandScope.PROJECT && projectPath) {
            if (!this.data.projects[projectPath]) {
                this.data.projects[projectPath] = [];
            }
            this.data.projects[projectPath].push(newCommand);
        } else {
            this.data.global.push(newCommand);
        }

        this.save();
        debug.log('Command added:', newCommand);
        return newCommand;
    }

    /**
     * Update an existing command
     * @param {string} id - Command ID
     * @param {Object} updates - Fields to update
     * @returns {Object|null} Updated command or null
     */
    updateCommand(id, updates) {
        // Search in global
        let idx = this.data.global.findIndex(c => c.id === id);
        if (idx !== -1) {
            const cmd = this.data.global[idx];
            this.data.global[idx] = {
                ...cmd,
                ...updates,
                id: cmd.id, // Preserve ID
                createdAt: cmd.createdAt, // Preserve creation date
                updatedAt: new Date().toISOString(),
            };
            this.save();
            return this.data.global[idx];
        }

        // Search in project commands
        for (const projectPath of Object.keys(this.data.projects)) {
            idx = this.data.projects[projectPath].findIndex(c => c.id === id);
            if (idx !== -1) {
                const cmd = this.data.projects[projectPath][idx];
                this.data.projects[projectPath][idx] = {
                    ...cmd,
                    ...updates,
                    id: cmd.id,
                    createdAt: cmd.createdAt,
                    updatedAt: new Date().toISOString(),
                };
                this.save();
                return this.data.projects[projectPath][idx];
            }
        }

        return null;
    }

    /**
     * Delete a command
     * @param {string} id - Command ID
     * @returns {boolean} True if deleted
     */
    deleteCommand(id) {
        // Try global
        const globalIdx = this.data.global.findIndex(c => c.id === id);
        if (globalIdx !== -1) {
            this.data.global.splice(globalIdx, 1);
            this.save();
            debug.log('Command deleted:', id);
            return true;
        }

        // Try project commands
        for (const projectPath of Object.keys(this.data.projects)) {
            const idx = this.data.projects[projectPath].findIndex(c => c.id === id);
            if (idx !== -1) {
                this.data.projects[projectPath].splice(idx, 1);
                // Clean up empty project arrays
                if (this.data.projects[projectPath].length === 0) {
                    delete this.data.projects[projectPath];
                }
                this.save();
                debug.log('Command deleted:', id);
                return true;
            }
        }

        return false;
    }

    /**
     * Toggle command enabled state
     * @param {string} id - Command ID
     * @returns {boolean|null} New enabled state or null if not found
     */
    toggleCommand(id) {
        const cmd = this.findCommandById(id);
        if (cmd) {
            const newState = cmd.enabled === false;
            this.updateCommand(id, { enabled: newState });
            return newState;
        }
        return null;
    }

    /**
     * Find command by ID (internal helper)
     */
    findCommandById(id) {
        const globalCmd = this.data.global.find(c => c.id === id);
        if (globalCmd) return globalCmd;

        for (const projectPath of Object.keys(this.data.projects)) {
            const cmd = this.data.projects[projectPath].find(c => c.id === id);
            if (cmd) return cmd;
        }
        return null;
    }

    /**
     * Expand variables in a template string
     * @param {string} template - Template with {variable} placeholders
     * @param {Object} context - Variable values
     * @returns {string} Expanded string
     */
    expandVariables(template, context = {}) {
        if (!template) return '';

        return template
            .replace(/\{input\}/g, context.input || '')
            .replace(/\{cwd\}/g, context.cwd || '')
            .replace(/\{session\}/g, context.session || '')
            .replace(/\{date\}/g, new Date().toISOString().split('T')[0])
            .replace(/\{time\}/g, new Date().toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }))
            .replace(/\{timestamp\}/g, new Date().toISOString());
    }

    /**
     * Export commands for backup/sharing
     * @param {string} scope - 'all', 'global', or project path
     * @returns {Object} Exportable data
     */
    exportCommands(scope = 'all') {
        const exported = {
            version: STORAGE_VERSION,
            exportedAt: new Date().toISOString(),
        };

        if (scope === 'all') {
            exported.global = this.data.global;
            exported.projects = this.data.projects;
        } else if (scope === 'global') {
            exported.global = this.data.global;
        } else {
            // Export specific project
            exported.project = scope;
            exported.commands = this.data.projects[scope] || [];
        }

        return exported;
    }

    /**
     * Import commands from exported data
     * @param {Object} data - Exported command data
     * @param {boolean} merge - Merge with existing or replace
     * @returns {Object} Import result
     */
    importCommands(data, merge = true) {
        const result = { imported: 0, skipped: 0 };

        if (!data || data.version !== STORAGE_VERSION) {
            return { error: 'Invalid or incompatible data format' };
        }

        // Import global commands
        if (data.global) {
            for (const cmd of data.global) {
                // Check for duplicate command names
                const existing = this.data.global.find(c => c.cmd === cmd.cmd);
                if (existing && merge) {
                    result.skipped++;
                    continue;
                }
                // Remove existing if not merging
                if (existing && !merge) {
                    this.data.global = this.data.global.filter(c => c.cmd !== cmd.cmd);
                }
                this.data.global.push({
                    ...cmd,
                    id: genCommandId(), // New ID to avoid conflicts
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                result.imported++;
            }
        }

        // Import project commands
        if (data.projects) {
            for (const [projectPath, commands] of Object.entries(data.projects)) {
                if (!this.data.projects[projectPath]) {
                    this.data.projects[projectPath] = [];
                }
                for (const cmd of commands) {
                    const existing = this.data.projects[projectPath].find(c => c.cmd === cmd.cmd);
                    if (existing && merge) {
                        result.skipped++;
                        continue;
                    }
                    if (existing && !merge) {
                        this.data.projects[projectPath] =
                            this.data.projects[projectPath].filter(c => c.cmd !== cmd.cmd);
                    }
                    this.data.projects[projectPath].push({
                        ...cmd,
                        id: genCommandId(),
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    result.imported++;
                }
            }
        }

        // Import single project commands
        if (data.project && data.commands) {
            const projectPath = data.project;
            if (!this.data.projects[projectPath]) {
                this.data.projects[projectPath] = [];
            }
            for (const cmd of data.commands) {
                const existing = this.data.projects[projectPath].find(c => c.cmd === cmd.cmd);
                if (existing && merge) {
                    result.skipped++;
                    continue;
                }
                this.data.projects[projectPath].push({
                    ...cmd,
                    id: genCommandId(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
                result.imported++;
            }
        }

        this.save();
        return result;
    }

    /**
     * Get count of all commands
     */
    getCommandCount() {
        let count = this.data.global.length;
        for (const commands of Object.values(this.data.projects)) {
            count += commands.length;
        }
        return count;
    }

    /**
     * Check if a command name is available
     * @param {string} cmdName - Command name to check
     * @param {string|null} projectPath - Project path for scope check
     * @param {string|null} excludeId - Command ID to exclude (for editing)
     * @returns {boolean} True if name is available
     */
    isCommandNameAvailable(cmdName, projectPath = null, excludeId = null) {
        const normalized = cmdName.startsWith('/') ? cmdName : '/' + cmdName;

        // Check global
        for (const cmd of this.data.global) {
            if (cmd.cmd === normalized && cmd.id !== excludeId) {
                return false;
            }
        }

        // Check project
        if (projectPath && this.data.projects[projectPath]) {
            for (const cmd of this.data.projects[projectPath]) {
                if (cmd.cmd === normalized && cmd.id !== excludeId) {
                    return false;
                }
            }
        }

        return true;
    }
}

// Singleton instance
let commandStoreInstance = null;

/**
 * Get or create CommandStore singleton
 */
export function getCommandStore() {
    if (!commandStoreInstance) {
        commandStoreInstance = new CommandStore();
    }
    return commandStoreInstance;
}

/**
 * Pre-built command templates for quick start
 */
export const COMMAND_TEMPLATES = [
    {
        cmd: '/explain',
        desc: 'Explain code or concept',
        type: CommandType.PROMPT,
        prompt: 'Please explain the following in detail:\n\n{input}\n\nFocus on what it does, why, and potential improvements.',
    },
    {
        cmd: '/review',
        desc: 'Code review',
        type: CommandType.PROMPT,
        prompt: 'Please review this code for:\n- Bugs or issues\n- Performance problems\n- Security concerns\n- Code style improvements\n\n{input}',
    },
    {
        cmd: '/test',
        desc: 'Generate unit tests',
        type: CommandType.PROMPT,
        prompt: 'Generate comprehensive unit tests for:\n\n{input}\n\nUse the testing framework already in this project.',
    },
    {
        cmd: '/fix',
        desc: 'Fix an issue',
        type: CommandType.PROMPT,
        prompt: 'Fix this issue: {input}\n\nExplain what was wrong and what you changed.',
    },
    {
        cmd: '/doc',
        desc: 'Generate documentation',
        type: CommandType.PROMPT,
        prompt: 'Generate documentation for:\n\n{input}\n\nInclude description, parameters, return values, and examples.',
    },
    {
        cmd: '/simplify',
        desc: 'Simplify code',
        type: CommandType.PROMPT,
        prompt: 'Simplify this code while maintaining functionality:\n\n{input}',
    },
];

export const SHELL_TEMPLATES = [
    { cmd: '/status', shell: 'git status', desc: 'Git status', type: CommandType.SHELL },
    { cmd: '/diff', shell: 'git diff', desc: 'Git diff', type: CommandType.SHELL },
    { cmd: '/log', shell: 'git log --oneline -10', desc: 'Recent commits', type: CommandType.SHELL },
    { cmd: '/branches', shell: 'git branch -a', desc: 'List branches', type: CommandType.SHELL },
];

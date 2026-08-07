/**
 * Quick Switcher — entry point.
 *
 * Registers the built-in providers and exposes the controller singleton.
 * Import this module once during app bootstrap.
 */

import S from '../strings.js';
import { QuickAccessRegistry } from './registry.js';
import { QuickSwitcherController } from './controller.js';
import { FileProvider } from './providers/file-provider.js';
import { ReadFilesProvider } from './providers/read-files-provider.js';
import { CommandProvider } from './providers/command-provider.js';
import { PanelProvider } from './providers/panel-provider.js';
import { ProjectProvider } from './providers/project-provider.js';
import { SkillsProvider } from './providers/skills-provider.js';

QuickAccessRegistry.register('>', () => new CommandProvider(), S.quick_switcher.placeholders.commands);
QuickAccessRegistry.register('#', () => new PanelProvider(), S.quick_switcher.placeholders.panels);
QuickAccessRegistry.register('~', () => new ProjectProvider(), S.quick_switcher.placeholders.projects);
QuickAccessRegistry.register('$', () => new SkillsProvider(), S.quick_switcher.placeholders.skills);
QuickAccessRegistry.register('!', () => new ReadFilesProvider(), S.quick_switcher.placeholders.read_files);
QuickAccessRegistry.register('file ', () => new FileProvider(), S.quick_switcher.placeholders.files);
QuickAccessRegistry.register('', () => new FileProvider(), S.quick_switcher.placeholders.default);

if (typeof window !== 'undefined') {
    window.QuickSwitcher = QuickSwitcherController;
}

export { QuickSwitcherController as QuickSwitcher };

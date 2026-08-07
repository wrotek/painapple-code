/**
 * QuickSwitcherController — wires picker UI ↔ provider registry.
 *
 * On every input change: strip the prefix, route to the matching provider,
 * fetch items, hand them back to the picker. A request token discards
 * out-of-order responses (user typed faster than the provider can answer).
 */

import S from '../strings.js';
import { ContextMenu } from '../context-menu.js';
import { OpenDialog } from '../open-dialog.js';
import { QuickAccessRegistry } from './registry.js';
import { QuickPicker } from './ui/picker.js';

const SECTION_TITLE = {
    file: S.quick_switcher.sections.files,
    'read-file': S.quick_switcher.sections.read_files,
    command: S.quick_switcher.sections.commands,
    panel: S.quick_switcher.sections.panels,
    project: S.quick_switcher.sections.projects,
    session: S.quick_switcher.sections.sessions,
    skill: S.quick_switcher.sections.skills,
};

class QuickSwitcherControllerClass {
    constructor() {
        this._picker = null;
        this._currentEntry = null;
        // Prefix becomes controller state once detected so the input box
        // doesn't have to carry it — the badge is the source of truth.
        this._activePrefix = '';
        this._reqToken = 0;
        this._ctxMenu = null;
        // Stash the parent-level query when drilling in so we can restore
        // it on drill-out (e.g. preserve project filter after viewing sessions).
        this._savedDrillQuery = '';
    }

    _ensure() {
        if (this._picker) return;
        this._picker = new QuickPicker({
            onValueChange: (v) => this._onChange(v),
            onSubmit: (opts) => this._onSubmit(opts),
            onCancel: () => this.hide(),
            onContextMenu: (e) => this._onContextMenu(e),
            onBackspaceEmpty: () => this._onBackspaceEmpty(),
            onDrillIn: (item) => this._drillIn(item),
            onDrillOut: () => this._drillOut(),
        });
    }

    show(initialValue = '') {
        this._ensure();
        this._activePrefix = '';
        this._currentEntry = null;
        this._savedDrillQuery = '';
        // Forget any transient provider state (e.g. drill-in) across opens.
        QuickAccessRegistry.resetAllInstances();
        // initialValue (e.g. '>') seeds the input so the prefix detection
        // can route to the matching provider on first paint. Used by the
        // command palette shortcut to open straight into command mode.
        this._picker.show(initialValue);
    }

    hide() {
        this._activePrefix = '';
        this._currentEntry = null;
        this._savedDrillQuery = '';
        this._picker?.hide();
    }

    toggle() {
        this._ensure();
        if (this._picker.isOpen()) this.hide();
        else this.show();
    }

    isOpen() {
        return !!this._picker?.isOpen();
    }

    async _onChange(value) {
        let entry;
        let query;

        // `@` hands off to the literal-path Open dialog. It's an action, not a
        // mode (no badge/provider) — a single keystroke swaps pickers. The
        // Open dialog mirrors this: Backspace on empty hands back here.
        if (!this._activePrefix && value === '@') {
            this.hide();
            OpenDialog.show();
            return;
        }

        if (this._activePrefix) {
            // Prefix is held as state; input value is already pure query.
            entry = QuickAccessRegistry.findByPrefix(this._activePrefix);
            query = value;
        } else {
            entry = QuickAccessRegistry.match(value);
            if (!entry) {
                this._picker.setItems([]);
                this._picker.setDrillHint(null);
                return;
            }
            if (entry.prefix) {
                // Newly typed prefix — peel it off the input and stash it.
                this._activePrefix = entry.prefix;
                query = QuickAccessRegistry.stripPrefix(value, entry.prefix);
                this._picker.setValue(query);
            } else {
                query = value;
            }
        }

        if (!entry) {
            this._picker.setItems([]);
            this._picker.setDrillHint(null);
            return;
        }

        if (entry !== this._currentEntry) {
            this._currentEntry = entry;
            this._picker.setPlaceholder(entry.placeholder);
            this._picker.setPrefix(entry.prefix);
        }

        const provider = QuickAccessRegistry.instance(entry);

        const token = ++this._reqToken;
        let items;
        try {
            items = await provider.getItems(query);
        } catch (err) {
            console.error('[QuickSwitcher] provider error:', err);
            items = [];
        }
        if (token !== this._reqToken) return;

        const sectionTitle = items.length && items[0].type
            ? SECTION_TITLE[items[0].type] || null
            : null;
        this._picker.setItems(items, sectionTitle);
        // "→ sessions" only applies to the projects list — the only place
        // where the right arrow drills in. Anywhere else it's noise.
        // While drilled into a project's sessions, "← back" applies instead.
        const drilled = !!provider.isDrilledIn?.();
        const canDrill = !!provider.drillIn && !drilled
            && items.some(it => it.type === 'project');
        const H = S.quick_switcher.hints;
        this._picker.setDrillHint(
            canDrill ? { key: H.keys.drill_in, label: H.labels.sessions }
            : drilled ? { key: H.keys.drill_out, label: H.labels.back }
            : null
        );
    }

    _clearPrefix() {
        if (!this._activePrefix) return;
        this._activePrefix = '';
        this._currentEntry = null;
        this._picker.setPrefix('');
        this._picker.setValue('');
        this._onChange('');
    }

    _onBackspaceEmpty() {
        // Priority: drill out of the provider first, then clear the prefix.
        const provider = this._currentEntry
            ? QuickAccessRegistry.instance(this._currentEntry)
            : null;
        if (provider?.isDrilledIn?.()) {
            this._drillOut();
            return;
        }
        this._clearPrefix();
    }

    _drillIn(item) {
        const provider = this._currentEntry
            ? QuickAccessRegistry.instance(this._currentEntry)
            : null;
        if (!provider?.drillIn) return;
        if (!provider.drillIn(item)) return;
        this._savedDrillQuery = this._picker.getValue();
        this._picker.setValue('');
        const newPlaceholder = provider.getDrillInPlaceholder?.() || this._currentEntry.placeholder;
        this._picker.setPlaceholder(newPlaceholder);
        this._onChange('');
    }

    _drillOut() {
        const provider = this._currentEntry
            ? QuickAccessRegistry.instance(this._currentEntry)
            : null;
        if (!provider?.drillOut) return;
        if (!provider.drillOut()) return;
        const restored = this._savedDrillQuery;
        this._savedDrillQuery = '';
        this._picker.setValue(restored);
        this._picker.setPlaceholder(this._currentEntry.placeholder);
        this._onChange(restored);
    }

    async _onSubmit(opts = {}) {
        const item = this._picker.getSelectedItem();
        if (!item || !this._currentEntry) return;
        const provider = QuickAccessRegistry.instance(this._currentEntry);
        this.hide();
        try {
            await provider.execute(item, opts);
        } catch (err) {
            console.error('[QuickSwitcher] execute error:', err);
        }
    }

    _onContextMenu({ item, x, y }) {
        if (!item || !this._currentEntry) return;
        const provider = QuickAccessRegistry.instance(this._currentEntry);
        const items = provider.getContextMenuItems?.(item) || [];
        if (!items.length) return;

        // Wrap each action so the picker also closes once the user picks one.
        const wrapped = items.map(i => {
            if (i.type === 'separator' || i.separator) return i;
            const original = i.action;
            return {
                ...i,
                action: async () => {
                    this.hide();
                    try { await original?.(); }
                    catch (err) { console.error('[QuickSwitcher] ctx action error:', err); }
                }
            };
        });

        const menu = window.app?.contextMenu || (this._ctxMenu ||= new ContextMenu());
        menu.show(x, y, wrapped);
    }
}

export const QuickSwitcherController = new QuickSwitcherControllerClass();

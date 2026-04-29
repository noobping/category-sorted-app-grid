import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import CategoryGridSorter from './categoryGridSorter.js';
import { formatError, logDebug, logWarningOnce } from './logging.js';

function getOverviewControls() {
    try {
        return Main.overview?._overview?._controls ?? null;
    } catch (e) {
        logWarningOnce('controls-lookup-failed',
            `Could not inspect overview controls (${formatError(e)}); using default app grid behavior`);
        return null;
    }
}

export default class CategorySortedAppGridExtension extends Extension {
    enable() {
        logDebug('Initialize the category-based grid sorter and perform initial grouping');

        const controls = getOverviewControls();
        const appDisplay = controls?._appDisplay ?? null;
        const stateAdjustment = controls?._stateAdjustment ?? null;
        const appSystem = Shell.AppSystem.get_default();

        if (!controls || !appDisplay || !stateAdjustment || !appSystem) {
            logWarningOnce('enable-missing-shell-internals',
                'Required Shell overview internals are unavailable; using default app grid behavior');
            this._gridSorter = null;
            return;
        }

        try {
            this._gridSorter = new CategoryGridSorter({
                controls,
                appDisplay,
                stateAdjustment,
                appSystem,
            });

            if (this._gridSorter.isReady())
                this._gridSorter.reorderGrid('Reordering app grid');
        } catch (e) {
            logWarningOnce('enable-failed',
                `Could not enable category sorting (${formatError(e)}); using default app grid behavior`);
            this._gridSorter?.destroy();
            this._gridSorter = null;
        }
    }

    disable() {
        this._gridSorter?.destroy();
        this._gridSorter = null;
        logDebug('Extension disabled, sorter destroyed');
    }
}

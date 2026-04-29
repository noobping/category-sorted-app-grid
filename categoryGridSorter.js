import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import AppDisplayPatches from './appDisplayPatches.js';
import { buildCategoryPositions } from './categorySorting.js';
import RedisplayQueue from './redisplayQueue.js';
import ShellSignalManager from './shellSignals.js';
import { formatError, logDebug, logWarningOnce } from './logging.js';

export default class CategoryGridSorter {
    constructor({ controls, appDisplay, stateAdjustment, appSystem }) {
        this._controls = controls;
        this._appDisplay = appDisplay;
        this._stateAdjustment = stateAdjustment;
        this._appSystem = appSystem;
        this._injectionManager = new InjectionManager();
        this._categoryPositions = new WeakMap();
        this._destroyed = false;
        this._suspendCategoryPositions = false;
        this._customSortingAvailable = false;
        this._appDisplayPatches = null;
        this._redisplayQueue = null;
        this._signalManager = null;

        logDebug('Initializing sorter...');
        this._appDisplayPatches = new AppDisplayPatches({
            injectionManager: this._injectionManager,
            getCategoryPosition: (appDisplay, item) => this._getCategoryPosition(appDisplay, item),
            redisplayAppDisplay: appDisplay => this._redisplayAppDisplay(appDisplay),
            isDestroyed: () => this._destroyed,
            setCategoryPositionsSuspended: suspended => {
                this._suspendCategoryPositions = suspended;
            },
            warnOnce: (key, message) => this._warnOnce(key, message),
        });
        this._redisplayQueue = new RedisplayQueue({
            getAppDisplay: () => this._getAppDisplay(),
            isReady: () => this.isReady(),
            warnOnce: (key, message) => this._warnOnce(key, message),
        });

        this._customSortingAvailable = this._appDisplayPatches.install();

        if (this._customSortingAvailable) {
            this._signalManager = new ShellSignalManager({
                stateAdjustment: this._stateAdjustment,
                appSystem: this._appSystem,
                reorderGrid: logText => this.reorderGrid(logText),
                warnOnce: (key, message) => this._warnOnce(key, message),
            });
            this._signalManager.connect();
        }
    }

    isReady() {
        return !this._destroyed && this._customSortingAvailable;
    }

    _warnOnce(key, message) {
        logWarningOnce(key, message);
    }

    _redisplayAppDisplay(appDisplay) {
        this._redisplayFolderViews(appDisplay);

        const oldApps = appDisplay._orderedItems.slice();
        const newApps = appDisplay._loadApps();

        if (!Array.isArray(newApps))
            throw new Error('_loadApps() did not return an array');

        this._prepareCategoryLayout(appDisplay, newApps);
        newApps.sort(appDisplay._compareItems.bind(appDisplay));

        const newIconsById = new Map(newApps.map(icon => [icon.id, icon]));
        const removedApps = oldApps.filter(icon => newIconsById.get(icon.id) !== icon);

        for (const icon of removedApps) {
            if (appDisplay._orderedItems.includes(icon))
                appDisplay._removeItem(icon);
            try {
                icon.destroy();
            } catch (e) {
                logDebug(`Failed to destroy stale item ${icon.id}: ${formatError(e)}`);
            }
        }

        for (const icon of newApps) {
            const [page, position] = appDisplay._getItemPosition(icon);

            if (!appDisplay._orderedItems.includes(icon)) {
                const gridPages = Math.max(appDisplay._grid?.nPages ?? 0, 0);

                if (page === -1 && position === -1 && gridPages > 1)
                    appDisplay._addItem(icon, 1, -1);
                else
                    appDisplay._addItem(icon, page, position);
            } else if (page !== -1 && position !== -1) {
                appDisplay._moveItem(icon, page, position);
            }
        }

        appDisplay.emit('view-loaded');
    }

    _prepareCategoryLayout(appDisplay, loadedIcons) {
        const { positions, categories } = buildCategoryPositions(appDisplay, loadedIcons);

        this._categoryPositions.set(appDisplay, positions);
        logDebug(`Categories found: ${categories.join(', ')}`);
    }

    _redisplayFolderViews(appDisplay) {
        const folderIcons = appDisplay._folderIcons;

        if (!Array.isArray(folderIcons)) {
            this._warnOnce('folder-icons-unavailable',
                'Folder icon list is unavailable; continuing without folder redisplay');
            return;
        }

        const liveFolderIcons = [];

        for (const folderIcon of folderIcons) {
            if (!folderIcon?.view || typeof folderIcon.view._redisplay !== 'function')
                continue;

            try {
                folderIcon.view._redisplay();
                liveFolderIcons.push(folderIcon);
            } catch (e) {
                logDebug(`Failed to redisplay folder ${folderIcon.id}: ${formatError(e)}`);
            }
        }

        appDisplay._folderIcons = liveFolderIcons;
    }

    _getCategoryPosition(appDisplay, item) {
        if (!item || this._suspendCategoryPositions)
            return null;

        const positions = this._categoryPositions?.get(appDisplay);
        if (!positions?.has(item.id))
            return null;

        return positions.get(item.id);
    }

    reorderGrid(logText) {
        this._redisplayQueue?.request(logText);
    }

    _getAppDisplay() {
        if (this._appDisplay)
            return this._appDisplay;

        this._appDisplay = this._controls?._appDisplay ?? null;
        return this._appDisplay;
    }

    destroy() {
        if (this._destroyed)
            return;

        logDebug('Destroying sorter, disconnecting signals and clearing patches...');
        this._destroyed = true;
        this._redisplayQueue?.destroy();
        this._signalManager?.destroy();

        // Remove all patched methods (restore original Shell behavior).
        this._injectionManager?.clear();
        logDebug('Patches cleared');

        this._injectionManager = null;
        this._controls = null;
        this._appSystem = null;
        this._appDisplay = null;
        this._stateAdjustment = null;
        this._categoryPositions = null;
        this._appDisplayPatches = null;
        this._redisplayQueue = null;
        this._signalManager = null;
        this._suspendCategoryPositions = false;
        this._customSortingAvailable = false;
    }
}

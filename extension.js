import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

const Controls = Main.overview?._overview?._controls;
const LOG_PREFIX = 'CategorySortedAppGrid';
const IGNORE_CATEGORIES = ['GTK', 'Qt', 'X-GNOME-Settings-Panel', 'GNOME'];

export default class CategorySortedAppGridExtension extends Extension {
    enable() {
        try {
            console.debug(`${LOG_PREFIX}: Initializing category-based grid sorter`);
            if (!Controls) throw new Error('Overview controls not found');
            this._gridSorter = new CategoryGridSorter();
        } catch (e) {
            console.error(`${LOG_PREFIX}: Failed to enable extension: ${e}`);
        }
    }

    disable() {
        try {
            if (this._gridSorter) {
                this._gridSorter.destroy();
                this._gridSorter = null;
                console.debug(`${LOG_PREFIX}: Extension disabled`);
            }
        } catch (e) {
            console.error(`${LOG_PREFIX}: Error during disable: ${e}`);
        }
    }
}

class CategoryGridSorter {
    constructor() {
        try {
            this._injectionManager = new InjectionManager();
            this._appSystem = Shell.AppSystem.get_default();
            this._appDisplay = Controls?._appDisplay;
            this._shellSettings = new Gio.Settings({ schema: 'org.gnome.shell' });
            this._folderSettings = new Gio.Settings({ schema: 'org.gnome.desktop.app-folders' });

            if (this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages)
                this._appDisplay._redisplay?.();

            this._patchShell();
            this._connectListeners();
        } catch (e) {
            console.error(`${LOG_PREFIX}: Initialization error: ${e}`);
        }
    }

    _patchShell() {
        try {
            if (!AppDisplay.AppDisplay.prototype._redisplay) {
                console.warn(`${LOG_PREFIX}: No _redisplay method to patch`);
                return;
            }

            this._injectionManager.overrideMethod(AppDisplay.AppDisplay.prototype, '_redisplay', () => {
                return function () {
                    if (!this) return;
                    try {
                        this._folderIcons?.forEach(folderIcon => folderIcon?.view?._redisplay());

                        const loadApps = this._loadApps?.();
                        if (!loadApps) return;

                        let userOrdered = Array.isArray(this._orderedItems) ? [...this._orderedItems] : [];
                        const allIcons = loadApps;

                        userOrdered = userOrdered.filter(icon => icon && allIcons.some(n => n.id === icon.id));
                        for (let icon of allIcons) {
                            if (icon && !userOrdered.some(i => i.id === icon.id)) userOrdered.push(icon);
                        }

                        let appIcons = [], folderIcons = [];
                        for (let icon of userOrdered) {
                            if (!icon) continue;
                            if (icon.app) appIcons.push(icon);
                            else folderIcons.push(icon);
                        }

                        const categoryCounts = {};
                        const appCategoryChoice = new Map();

                        // Gather categories and count them
                        for (let icon of appIcons) {
                            if (!icon.app) continue;
                            let categoriesList = [];
                            try {
                                const info = Gio.DesktopAppInfo.new(icon.app.get_id());
                                const catsStr = info?.get_categories()?.trim() || '';
                                categoriesList = catsStr ? catsStr.replace(/;$/, '').split(';') : [];
                            } catch (e) {
                                console.error(`${LOG_PREFIX}: Error reading categories for app: ${e}`);
                            }
                            if (!categoriesList.length) categoriesList = ['Other'];

                            const hasNonIgnored = categoriesList.some(c => !IGNORE_CATEGORIES.includes(c));
                            const filteredCats = hasNonIgnored ? categoriesList.filter(c => !IGNORE_CATEGORIES.includes(c)) : categoriesList;

                            appCategoryChoice.set(icon, filteredCats);
                            filteredCats.forEach(cat => categoryCounts[cat] = (categoryCounts[cat] || 0) + 1);
                        }

                        // Assign each app to the category with the most apps
                        const groups = {};
                        for (let [icon, cats] of appCategoryChoice.entries()) {
                            if (!cats.length) continue;
                            const chosen = cats.reduce((best, cur) => {
                                if ((categoryCounts[cur] || 0) > (categoryCounts[best] || 0)) return cur;
                                if ((categoryCounts[cur] || 0) === (categoryCounts[best] || 0)) return cur.localeCompare(best) < 0 ? cur : best;
                                return best;
                            }, cats[0]);
                            groups[chosen] = groups[chosen] || [];
                            groups[chosen].push(icon);
                        }

                        // Sort category groups alphabetically
                        const categoryNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
                        console.info(`${LOG_PREFIX}: Categories: ${categoryNames.join(', ')}`);

                        // Build new ordered list: apps grouped by category
                        let newOrder = [...folderIcons];
                        categoryNames.forEach(cat => { newOrder.push(...groups[cat]); });

                        // Remove icons no longer present
                        const currentItems = Array.isArray(this._orderedItems) ? [...this._orderedItems] : [];
                        const newIds = newOrder.map(i => i.id);

                        currentItems.forEach(item => {
                            if (item && !newIds.includes(item.id)) {
                                try { this._removeItem?.(item); item.destroy?.(); } catch { };
                            }
                        });

                        // Add or move icons to match the new order
                        const itemsPerPage = this._grid?.itemsPerPage || 1;
                        newOrder.forEach((icon, idx) => {
                            if (!icon) return;
                            const page = Math.floor(idx / itemsPerPage);
                            const pos = idx % itemsPerPage;
                            try {
                                if (!currentItems.includes(icon)) this._addItem?.(icon, page, pos);
                                else this._moveItem?.(icon, page, pos);
                            } catch { };
                        });

                        this._orderedItems = newOrder;
                        this.emit?.('view-loaded');
                        console.info(`${LOG_PREFIX}: Redisplay done`);
                    } catch (inner) {
                        console.error(`${LOG_PREFIX}: Redisplay error: ${inner}`);
                    }
                };
            });

            if (AppDisplay.AppDisplay.prototype._onDestroy) {
                this._injectionManager.overrideMethod(AppDisplay.AppDisplay.prototype, '_onDestroy', (orig) => function (...args) {
                    try {
                        return orig.apply(this, args);
                    } catch (inner) {
                        console.error(`${LOG_PREFIX}: onDestroy error: ${inner}`);
                    }
                });
            }
        } catch (e) {
            console.error(`${LOG_PREFIX}: PatchShell error: ${e}`);
        }
    }

    _connectListeners() {
        try {
            this._shellSettings?.connectObject('changed::app-picker-layout', () => this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages && this._appDisplay._redisplay?.(), this);
            this._shellSettings?.connectObject('changed::favorite-apps', () => this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages && this._appDisplay._redisplay?.(), this);
            Main.overview?.connectObject('item-drag-end', () => this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages && this._appDisplay._redisplay?.(), this);
            this._folderSettings?.connectObject('changed::folder-children', () => this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages && this._appDisplay._redisplay?.(), this);
            this._appSystem?.connectObject('installed-changed', () => this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages && this._appDisplay._redisplay?.(), this);
            Controls?._stateAdjustment?.connectObject('notify::value', () => {
                if (Controls._stateAdjustment.value === OverviewControls.ControlsState.APP_GRID && this._appDisplay?._pageManager && !this._appDisplay._pageManager._updatingPages) {
                    this._appDisplay._redisplay?.();
                }
            }, this);
        } catch (e) {
            console.error(`${LOG_PREFIX}: Listener error: ${e}`);
        }
    }

    destroy() {
        try {
            Main.overview?.disconnectObject(this);
            Controls?._stateAdjustment?.disconnectObject(this);
            this._appSystem?.disconnectObject(this);
            this._shellSettings?.disconnectObject(this);
            this._folderSettings?.disconnectObject(this);
            this._injectionManager?.clear();
            console.debug(`${LOG_PREFIX}: Restored`);
        } catch (e) {
            console.error(`${LOG_PREFIX}: Restore error: ${e}`);
        }
    }
}

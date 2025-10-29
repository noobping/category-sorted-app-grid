import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

const Controls = Main.overview._overview._controls;
const LOG_PREFIX = 'CategorySortedAppGrid';
const IGNORE_CATEGORIES = ['GTK', 'Qt', 'X-GNOME-Settings-Panel', 'GNOME'];

export default class CategorySortedAppGridExtension extends Extension {
    enable() {
        console.debug(`${LOG_PREFIX}: Initialize the category-based grid sorter and perform initial grouping`);
        this._gridSorter = new CategoryGridSorter();
        this._gridSorter.reorderGrid('Reordering app grid');
    }

    disable() {
        // Disconnect signals and remove patches
        if (this._gridSorter) {
            this._gridSorter.destroy();
            this._gridSorter = null;
            console.debug(`${LOG_PREFIX}: Extension disabled, sorter destroyed`);
        }
    }
}

class CategoryGridSorter {
    constructor() {
        this._injectionManager = new InjectionManager();
        this._appSystem = Shell.AppSystem.get_default();
        this._appDisplay = Controls._appDisplay;
        this._shellSettings = new Gio.Settings({ schema: 'org.gnome.shell' });
        this._folderSettings = new Gio.Settings({ schema: 'org.gnome.desktop.app-folders' });
        this._currentlyUpdating = false;

        console.debug(`${LOG_PREFIX}: Initializing sorter...`);
        this._patchShell();       // Patch GNOME Shell methods for custom behavior
        this._connectListeners(); // Connect event listeners for dynamic updates
    }

    _patchShell() {
        // Override the app grid redisplay method to group apps by category
        this._injectionManager.overrideMethod(AppDisplay.AppDisplay.prototype, '_redisplay', () => {
            return function () {
                console.debug(`${LOG_PREFIX}: Ensure any app folder icons update their contents`);
                this._folderIcons.forEach(folderIcon => folderIcon.view._redisplay());

                console.debug(`${LOG_PREFIX}: Get all application icons (including folders)`);
                // Start with current user-ordered items (if any)
                let userOrdered = this._orderedItems ? [...this._orderedItems] : [];
                let allIcons = this._loadApps();

                // Remove any icons that no longer exist
                userOrdered = userOrdered.filter(icon => allIcons.some(newIcon => newIcon.id === icon.id));

                // Add any new icons (apps or folders) that are not in the current list
                for (let icon of allIcons) {
                    if (!userOrdered.some(item => item.id === icon.id)) {
                        userOrdered.push(icon);
                    }
                }
                let icons = userOrdered;

                // Separate normal app icons from folder icons
                let appIcons = [], folderIcons = [];
                for (let icon of icons) {
                    if (icon.app) appIcons.push(icon);
                    else folderIcons.push(icon);
                }

                // Determine category for each app icon
                let categoryCounts = {};
                let appCategoryChoice = new Map(); // Map app -> [eligible categories]

                // First pass: gather categories and count them
                for (let icon of appIcons) {
                    let app = icon.app;
                    let categoriesList = [];
                    try {
                        // Get the Categories field from the .desktop file
                        let info = Gio.DesktopAppInfo.new(app.get_id());
                        let catsStr = info ? info.get_categories() : null;
                        if (catsStr) {
                            catsStr = catsStr.trim();
                            if (catsStr.endsWith(';'))
                                catsStr = catsStr.slice(0, -1);
                            categoriesList = catsStr.split(';').filter(c => c.length > 0);
                        }
                    } catch (e) {
                        console.error(`${LOG_PREFIX}: Error reading categories for ${app.get_id()}: ${e}`);
                    }
                    if (categoriesList.length === 0) {
                        categoriesList = ['Other'];
                    }

                    // Apply ignore list filtering:
                    let filteredCats;
                    const hasNonIgnored = categoriesList.some(cat => !IGNORE_CATEGORIES.includes(cat));
                    if (hasNonIgnored) {
                        // use only non-ignored categories
                        filteredCats = categoriesList.filter(cat => !IGNORE_CATEGORIES.includes(cat));
                    } else {
                        // all categories are ignored (or none non-ignored), so keep them
                        filteredCats = categoriesList;
                    }

                    appCategoryChoice.set(icon, filteredCats);

                    // Count each category for size comparison
                    for (let cat of filteredCats) {
                        if (!categoryCounts[cat]) categoryCounts[cat] = 0;
                        categoryCounts[cat] += 1;
                    }
                }

                // Second pass: assign each app to the category with the most apps
                let groups = {};
                for (let icon of appIcons) {
                    let cats = appCategoryChoice.get(icon);  // categories considered for this app
                    let chosenCategory = cats[0];
                    if (cats.length > 1) {
                        // find category with max count
                        chosenCategory = cats.reduce((bestCat, currentCat) => {
                            if (categoryCounts[currentCat] > categoryCounts[bestCat]) {
                                return currentCat;
                            } else if (categoryCounts[currentCat] === categoryCounts[bestCat]) {
                                // tie-breaker: choose alphabetically
                                return (currentCat.localeCompare(bestCat) < 0) ? currentCat : bestCat;
                            }
                            return bestCat;
                        }, cats[0]);
                    }
                    // Add the app icon to its chosen category group
                    if (!groups[chosenCategory]) {
                        groups[chosenCategory] = [];
                    }
                    groups[chosenCategory].push(icon);
                }

                // Sort category groups alphabetically
                let categoryNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
                console.info(`${LOG_PREFIX}: Categories found: ${categoryNames.join(', ')}`);

                // Build new ordered list: apps grouped by category, then folders
                let newOrder = [];
                for (let category of categoryNames) {
                    newOrder.push(...groups[category]);
                }
                newOrder.push(...folderIcons);

                // Remove icons that are no longer present in the new order
                let currentItems = this._orderedItems.slice();
                let newIds = newOrder.map(icon => icon.id);
                for (let item of currentItems) {
                    if (!newIds.includes(item.id)) {
                        this._removeItem(item);
                        item.destroy();
                    }
                }

                // Add or move icons to match the new order
                const { itemsPerPage } = this._grid;
                newOrder.forEach((icon, index) => {
                    const page = Math.floor(index / itemsPerPage);
                    const position = index % itemsPerPage;
                    if (!currentItems.includes(icon)) {
                        // New icon (e.g. newly installed app or new folder)
                        this._addItem(icon, page, position);
                    } else {
                        // Existing icon: update its position if it changed
                        this._moveItem(icon, page, position);
                    }
                });

                // Update the ordered list and signal that the view has loaded
                this._orderedItems = newOrder;
                this.emit('view-loaded');
                console.info(`${LOG_PREFIX}: Redisplay complete, ${newOrder.length} icons placed`);
            };
        });
    }

    _connectListeners() {
        console.debug(`${LOG_PREFIX}: Connecting listeners...`);
        // Reorder when the app grid layout or favorites list changes (apps moved or layout altered)
        this._shellSettings.connectObject(
            'changed::app-picker-layout', () => this.reorderGrid('App grid layout changed, triggering reorder...'),
            'changed::favorite-apps', () => this.reorderGrid('Favorite apps changed, triggering reorder...'),
            this
        );

        // Reorder after an app icon drag-and-drop (user rearranged apps)
        Main.overview.connectObject(
            'item-drag-end', () => this.reorderGrid('App movement detected, triggering reorder...'),
            this
        );

        // Reorder when app folders are created or deleted
        this._folderSettings.connectObject(
            'changed::folder-children', () => this.reorderGrid('Folders changed, triggering reorder...'),
            this
        );

        // Reorder when apps are installed or removed
        this._appSystem.connectObject(
            'installed-changed', () => this.reorderGrid('Installed apps changed, triggering reorder...'),
            this
        );

        // Reorder every time the Applications overview (app grid) is opened
        Controls._stateAdjustment.connectObject(
            'notify::value', () => {
                if (Controls._stateAdjustment.value === OverviewControls.ControlsState.APP_GRID) {
                    this.reorderGrid('App grid opened, triggering reorder...');
                }
            },
            this
        );
    }

    reorderGrid(logText) {
        console.debug(`${LOG_PREFIX}: ${logText}`);
        // Avoid overlapping updates and wait until any ongoing page update is finished
        if (!this._currentlyUpdating && !this._appDisplay._pageManager._updatingPages) {
            this._currentlyUpdating = true;
            this._appDisplay._redisplay(); // Rebuild the app grid with the new ordering
            this._currentlyUpdating = false;
        }
    }

    destroy() {
        console.debug(`${LOG_PREFIX}: Destroying sorter, disconnecting signals and clearing patches...`);
        Main.overview.disconnectObject(this);
        Controls._stateAdjustment.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._shellSettings.disconnectObject(this);
        this._folderSettings.disconnectObject(this);

        // Remove all patched methods (restore original Shell behavior)
        this._injectionManager.clear();
        console.debug(`${LOG_PREFIX}: Patches cleared`);
    }
}

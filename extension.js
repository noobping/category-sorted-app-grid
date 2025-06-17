import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

const Controls = Main.overview._overview._controls;
const LOG_PREFIX = 'CategorySortedAppGrid';

export default class CategorySortedAppGridExtension extends Extension {
    enable() {
        log(`${LOG_PREFIX}: Initialize the category-based grid sorter and perform initial grouping`);
        this._gridSorter = new CategoryGridSorter();
        this._gridSorter.reorderGrid('Reordering app grid');
    }

    disable() {
        // Disconnect signals and remove patches
        if (this._gridSorter) {
            this._gridSorter.destroy();
            this._gridSorter = null;
            log(`${LOG_PREFIX}: Extension disabled, sorter destroyed`);
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

        log(`${LOG_PREFIX}: Initializing sorter...`);
        this._patchShell();       // Patch GNOME Shell methods for custom behavior
        this._connectListeners(); // Connect event listeners for dynamic updates
    }

    _patchShell() {
        // Override the app grid redisplay method to group apps by category
        this._injectionManager.overrideMethod(AppDisplay.AppDisplay.prototype, '_redisplay', () => {
            return function () {
                log(`${LOG_PREFIX}: Ensure any app folder icons update their contents`);
                this._folderIcons.forEach(folderIcon => folderIcon.view._redisplay());

                log(`${LOG_PREFIX}: Get all application icons (including folders)`);
                let icons = this._loadApps();

                // Separate normal app icons from folder icons
                let appIcons = [];
                let folderIcons = [];
                for (let icon of icons) {
                    if (icon.app) appIcons.push(icon);
                    else folderIcons.push(icon);
                }

                log(`${LOG_PREFIX}: Group apps by category (assign each app to its largest category)`);
                let categoryCounts = {};
                let appCategoriesMap = {};

                // First pass: gather categories for each app and count category sizes
                for (let icon of appIcons) {
                    let app = icon.app;
                    let categoriesStr = null;
                    let catList = [];
                    try {
                        // Get the Categories field from the .desktop file (unparsed string)
                        let info = Gio.DesktopAppInfo.new(app.get_id());
                        categoriesStr = info.get_categories();
                    } catch (e) {
                        log(`${LOG_PREFIX}: Error reading categories for ${app.get_id()}: ${e}`);
                    }
                    if (categoriesStr) {
                        let cats = categoriesStr.trim();
                        if (cats.endsWith(';'))
                            cats = cats.slice(0, -1);  // drop trailing semicolon if present
                        catList = cats.split(';').filter(c => c.length > 0);
                    }
                    if (catList.length === 0) {
                        catList = ['Other'];  // default category if none specified
                    }
                    // Remove duplicate category names (just in case) and record them
                    catList = [...new Set(catList)];
                    appCategoriesMap[app.get_id()] = catList;
                    // Update counts for each category this app belongs to
                    for (let category of catList) {
                        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
                    }
                }

                // Second pass: assign each app to the category with the most apps
                let groups = {};
                for (let icon of appIcons) {
                    let appId = icon.app.get_id();
                    let categories = appCategoriesMap[appId] || ['Other'];
                    // Pick the category with the highest count (largest group)
                    let chosen = categories[0];
                    for (let category of categories) {
                        if (categoryCounts[category] > categoryCounts[chosen] ||
                            (categoryCounts[category] === categoryCounts[chosen] &&
                                category.localeCompare(chosen) < 0)) {
                            chosen = category;
                        }
                    }
                    // Add the app icon to its chosen category group
                    if (!groups[chosen]) {
                        groups[chosen] = [];
                    }
                    groups[chosen].push(icon);
                }

                // Sort categories alphabetically
                let categoryNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
                log(`${LOG_PREFIX}: Categories found: ${categoryNames.join(', ')}`);

                // Build the new ordered list of icons: each category group (alphabetical), then all folders
                let newOrder = [];
                for (let category of categoryNames) {
                    // (Optional: sort icons within each category alphabetically by name)
                    groups[category].sort((a, b) => a.app.get_name().localeCompare(b.app.get_name()));
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
                log(`${LOG_PREFIX}: Redisplay complete, ${newOrder.length} icons placed`);
            };
        });
    }

    _connectListeners() {
        log(`${LOG_PREFIX}: Connecting listeners...`);
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

    /**
     * Reorder the app grid if not already updating.
     * A slight delay is used to avoid conflicts with animations.
     */
    reorderGrid(logText) {
        log(`${LOG_PREFIX}: ${logText}`);
        // Avoid overlapping updates and wait until any ongoing page update is finished
        if (!this._currentlyUpdating && !this._appDisplay._pageManager._updatingPages) {
            this._currentlyUpdating = true;
            // Slight delay to avoid clashing with animations
            this._reorderGridTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                // Rebuild the app grid with the new ordering
                this._appDisplay._redisplay();
                this._currentlyUpdating = false;
                this._reorderGridTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    destroy() {
        log(`${LOG_PREFIX}: Destroying sorter, disconnecting signals and clearing patches...`);
        Main.overview.disconnectObject(this);
        Controls._stateAdjustment.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._shellSettings.disconnectObject(this);
        this._folderSettings.disconnectObject(this);

        // Cancel any pending timeout
        if (this._reorderGridTimeoutId != null) {
            GLib.Source.remove(this._reorderGridTimeoutId);
        }

        // Remove all patched methods (restore original Shell behavior)
        this._injectionManager.clear();
        log(`${LOG_PREFIX}: Patches cleared`);
    }
}

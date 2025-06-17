import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

const Controls = Main.overview._overview._controls;

export default class CategorySortedAppGridExtension extends Extension {
    enable() {
        // Initialize the category-based grid sorter and perform initial grouping
        this._gridSorter = new CategoryGridSorter();
        this._gridSorter.reorderGrid('Reordering app grid');
    }

    disable() {
        // Disconnect signals and remove patches
        if (this._gridSorter) {
            this._gridSorter.destroy();
            this._gridSorter = null;
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

        // Patch GNOME Shell methods for custom behavior
        this._patchShell();
        // Connect event listeners for dynamic updates
        this._connectListeners();
    }

    _patchShell() {
        // Override the app grid redisplay method to group apps by category
        this._injectionManager.overrideMethod(AppDisplay.AppDisplay.prototype, '_redisplay', () => {
            return function () {
                // Ensure any app folder icons update their contents
                this._folderIcons.forEach(folderIcon => folderIcon.view._redisplay());

                // Get all application icons (including folder icons) in their current order
                let icons = this._loadApps();

                // Separate regular app icons from folder icons
                let appIcons = [];
                let folderIcons = [];
                for (let icon of icons) {
                    if (icon.app) {
                        appIcons.push(icon);
                    } else {
                        folderIcons.push(icon);
                    }
                }

                // Group app icons by their first category
                let groups = {};
                for (let icon of appIcons) {
                    let app = icon.app;
                    let firstCategory = null;
                    try {
                        // Use .desktop file info to get categories
                        let info = Gio.DesktopAppInfo.new(app.get_id());
                        let categories = info.get_categories();
                        if (categories) {
                            // Take the first category from the semicolon-separated list
                            let catsStr = categories.trim();
                            if (catsStr.endsWith(';')) {
                                catsStr = catsStr.slice(0, -1);
                            }
                            let catList = catsStr.split(';').filter(c => c.length > 0);
                            if (catList.length > 0) {
                                firstCategory = catList[0];
                            }
                        }
                    } catch (e) {
                        // If any error occurs (or no category), leave firstCategory as null
                    }
                    if (!firstCategory) {
                        firstCategory = 'Other';
                    }
                    if (!groups[firstCategory]) {
                        groups[firstCategory] = [];
                    }
                    // Preserve original ordering by pushing icons as they appear
                    groups[firstCategory].push(icon);
                }

                // Sort category groups alphabetically by category name
                let categoryNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

                // Build the new ordered list of icons: each category group, then all folders
                let newOrder = [];
                for (let category of categoryNames) {
                    newOrder.push(...groups[category]);
                }
                // Place folder icons after all category groups
                newOrder.push(...folderIcons);

                // Remove icons that no longer exist
                let currentItems = this._orderedItems.slice();
                let currentIds = currentItems.map(icon => icon.id);
                let newIds = newOrder.map(icon => icon.id);
                let removedIcons = currentItems.filter(icon => !newIds.includes(icon.id));
                for (let icon of removedIcons) {
                    this._removeItem(icon);
                    icon.destroy();
                }

                // Add or move icons to match the new grouped order
                const { itemsPerPage } = this._grid;
                newOrder.forEach((icon, index) => {
                    const page = Math.floor(index / itemsPerPage);
                    const position = index % itemsPerPage;
                    if (!currentIds.includes(icon.id)) {
                        // New icon (e.g., newly installed app or new folder)
                        this._addItem(icon, page, position);
                    } else {
                        // Existing icon: update its position if changed
                        this._moveItem(icon, page, position);
                    }
                });

                // Update the ordered list and signal that the view has loaded
                this._orderedItems = newOrder;
                this.emit('view-loaded');
            };
        });
    }

    _connectListeners() {
        // Reorder when the app grid layout or favorites list changes (apps moved or layout altered)
        this._shellSettings.connectObject(
            'changed::app-picker-layout', () => this.reorderGrid('App grid layout changed, triggering reorder'),
            'changed::favorite-apps', () => this.reorderGrid('Favorite apps changed, triggering reorder'),
            this
        );

        // Reorder after an app icon drag-and-drop (user rearranged apps)
        Main.overview.connectObject(
            'item-drag-end', () => this.reorderGrid('App movement detected, triggering reorder'),
            this
        );

        // Reorder when app folders are created or deleted
        this._folderSettings.connectObject(
            'changed::folder-children', () => this.reorderGrid('Folders changed, triggering reorder'),
            this
        );

        // Reorder when apps are installed or removed
        this._appSystem.connectObject(
            'installed-changed', () => this.reorderGrid('Installed apps changed, triggering reorder'),
            this
        );

        // Reorder every time the Applications overview (app grid) is opened
        Controls._stateAdjustment.connectObject(
            'notify::value', () => {
                if (Controls._stateAdjustment.value === OverviewControls.ControlsState.APP_GRID) {
                    this.reorderGrid('App grid opened, triggering reorder');
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
        // Disconnect all signals associated with this sorter
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
    }
}

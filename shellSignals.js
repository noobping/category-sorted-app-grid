import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { formatError, logDebug } from './logging.js';

const APP_FOLDERS_SCHEMA = 'org.gnome.desktop.app-folders';

export default class ShellSignalManager {
    constructor({ stateAdjustment, appSystem, reorderGrid, warnOnce }) {
        this._stateAdjustment = stateAdjustment;
        this._appSystem = appSystem;
        this._reorderGrid = reorderGrid;
        this._warnOnce = warnOnce;
        this._folderSettings = null;
        this._destroyed = false;
    }

    connect() {
        if (this._destroyed)
            return;

        logDebug('Connecting listeners...');

        this._connectObject(global.settings,
            'changed::app-picker-layout', () => this._reorderGrid('App grid layout changed, triggering reorder...'),
            'changed::favorite-apps', () => this._reorderGrid('Favorite apps changed, triggering reorder...'));

        this._connectObject(Main.overview,
            'item-drag-end', () => this._reorderGrid('App movement detected, triggering reorder...'));

        this._connectObject(this._appSystem,
            'installed-changed', () => this._reorderGrid('Installed apps changed, triggering reorder...'));

        this._connectFolderSettings();

        this._connectObject(this._stateAdjustment,
            'notify::value', () => {
                if (this._stateAdjustment?.value === OverviewControls.ControlsState.APP_GRID)
                    this._reorderGrid('App grid opened, triggering reorder...');
            });
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._disconnectObject(Main.overview);
        this._disconnectObject(this._stateAdjustment);
        this._disconnectObject(global.settings);
        this._disconnectObject(this._appSystem);
        this._disconnectObject(this._folderSettings);
        this._folderSettings = null;
    }

    _connectObject(object, ...signalsAndCallbacks) {
        if (!object || typeof object.connectObject !== 'function') {
            this._warnOnce('connect-object-unavailable',
                'A Shell signal source is unavailable; some automatic reorders may be skipped');
            return;
        }

        try {
            object.connectObject(...signalsAndCallbacks, this);
        } catch (e) {
            this._warnOnce('connect-object-failed',
                `Could not connect a Shell signal (${formatError(e)}); some automatic reorders may be skipped`);
        }
    }

    _connectFolderSettings() {
        if (typeof global.get_settings !== 'function') {
            logDebug('global.get_settings is unavailable');
            return;
        }

        try {
            this._folderSettings = global.get_settings(APP_FOLDERS_SCHEMA);
            this._connectObject(this._folderSettings,
                'changed::folder-children', () => this._reorderGrid('Folders changed, triggering reorder...'));
        } catch (e) {
            this._folderSettings = null;
            this._warnOnce('folder-settings-failed',
                `Could not watch app folder settings (${formatError(e)}); folder changes may require reopening the app grid`);
        }
    }

    _disconnectObject(object) {
        if (!object || typeof object.disconnectObject !== 'function')
            return;

        try {
            object.disconnectObject(this);
        } catch (e) {
            logDebug(`Failed to disconnect signal source: ${formatError(e)}`);
        }
    }
}

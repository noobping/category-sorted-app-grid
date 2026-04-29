import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';

import { formatError } from './logging.js';

function callOriginalMethod(originalMethod, target, args, fallbackValue = undefined) {
    if (typeof originalMethod !== 'function')
        return fallbackValue;

    return originalMethod.call(target, ...args);
}

export default class AppDisplayPatches {
    constructor({
        injectionManager,
        getCategoryPosition,
        redisplayAppDisplay,
        isDestroyed,
        setCategoryPositionsSuspended,
        warnOnce,
    }) {
        this._injectionManager = injectionManager;
        this._getCategoryPosition = getCategoryPosition;
        this._redisplayAppDisplay = redisplayAppDisplay;
        this._isDestroyed = isDestroyed;
        this._setCategoryPositionsSuspended = setCategoryPositionsSuspended;
        this._warnOnce = warnOnce;
    }

    install() {
        const prototype = AppDisplay.AppDisplay?.prototype;

        if (!prototype) {
            this._warnOnce('missing-appdisplay-prototype',
                'AppDisplay prototype is unavailable; using default app grid behavior');
            return false;
        }

        try {
            this._patchRedisplay(prototype);
            this._patchItemPosition(prototype);
        } catch (e) {
            this._warnOnce('patch-failed',
                `Could not patch Shell app display (${formatError(e)}); using default app grid behavior`);
            this._injectionManager?.clear();
            return false;
        }

        return true;
    }

    _patchRedisplay(prototype) {
        const patches = this;

        // Keep GNOME Shell's own add/remove/destroy lifecycle, but feed it
        // category-based positions so stale folder/app actors are not reused.
        this._injectionManager.overrideMethod(prototype, '_redisplay', originalMethod => {
            return function (...args) {
                if (patches._isDestroyed())
                    return patches._callOriginalRedisplay(originalMethod, this, args);

                if (!patches._canRedisplayAppDisplay(this)) {
                    patches._warnOnce('redisplay-fallback',
                        'AppDisplay internals are incompatible; using default app grid behavior');
                    return patches._callOriginalRedisplay(originalMethod, this, args);
                }

                try {
                    return patches._redisplayAppDisplay(this);
                } catch (e) {
                    patches._warnOnce('redisplay-failed',
                        `Custom redisplay failed (${formatError(e)}); using default app grid behavior`);
                    return patches._callOriginalRedisplay(originalMethod, this, args);
                }
            };
        });
    }

    _patchItemPosition(prototype) {
        const patches = this;

        this._injectionManager.overrideMethod(prototype, '_getItemPosition', originalMethod => {
            return function (...args) {
                const [item] = args;

                if (!patches._isDestroyed()) {
                    const position = patches._getCategoryPosition(this, item);
                    if (position)
                        return position;
                }

                return callOriginalMethod(originalMethod, this, args, [-1, -1]);
            };
        });
    }

    _callOriginalRedisplay(originalMethod, appDisplay, args) {
        this._setCategoryPositionsSuspended(true);

        try {
            return callOriginalMethod(originalMethod, appDisplay, args);
        } finally {
            this._setCategoryPositionsSuspended(false);
        }
    }

    _canRedisplayAppDisplay(appDisplay) {
        if (!appDisplay)
            return false;

        if (!Array.isArray(appDisplay._orderedItems))
            return false;

        if (!Array.isArray(appDisplay._folderIcons))
            return false;

        if (!appDisplay._grid || !appDisplay._pageManager)
            return false;

        for (const methodName of ['_loadApps', '_compareItems', '_removeItem', '_addItem', '_moveItem']) {
            if (typeof appDisplay[methodName] !== 'function')
                return false;
        }

        return typeof appDisplay.emit === 'function';
    }
}

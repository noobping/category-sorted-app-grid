import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'category-sorted-app-grid@noobping.dev';

export var METRICS = {};

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitForExtensionState() {
    let lastState = 'not loaded';

    for (let attempt = 0; attempt < 50; attempt++) {
        const extension = Main.extensionManager.lookup(UUID);

        if (extension) {
            lastState = `${extension.state}`;

            if (extension.state === ExtensionState.ERROR && extension.error)
                throw new Error(`Extension ${UUID} failed: ${extension.error}`);

            if (extension.state === ExtensionState.ACTIVE && extension.stateObj)
                return extension.stateObj;
        }

        await Scripting.sleep(100);
    }

    throw new Error(`Timed out waiting for ${UUID}; last state was ${lastState}`);
}

function getAppDisplay() {
    const controls = Main.overview?._overview?._controls ?? null;
    return controls?._appDisplay ?? null;
}

export async function run() {
    console.debug('Running Category Sorted App Grid extension smoke test');

    Scripting.defineScriptEvent('extensionEnabled',
        'Category sorted app grid extension enabled');
    Scripting.defineScriptEvent('applicationsShowDone',
        'App grid finished showing with extension enabled');

    await Scripting.waitLeisure();

    const extensionState = await waitForExtensionState();
    assert(extensionState._gridSorter?.isReady(),
        `${UUID} did not initialize the app grid sorter`);
    Scripting.scriptEvent('extensionEnabled');

    Main.overview.show();
    await Scripting.waitLeisure();

    assert(getAppDisplay(), 'App display is unavailable');
    assert(Main.overview.dash?.showAppsButton, 'Show Apps button is unavailable');

    Main.overview.dash.showAppsButton.checked = true;
    await Scripting.waitLeisure();
    Scripting.scriptEvent('applicationsShowDone');

    Main.overview.dash.showAppsButton.checked = false;
    Main.overview.hide();
    await Scripting.waitLeisure();

    console.debug('Finished Category Sorted App Grid extension smoke test');
}

export function finish() {
}

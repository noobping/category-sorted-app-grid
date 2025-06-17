import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class CategorySortedAppGridExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._overviewId = 0;
    }

    getAppCategories(app) {
        try {
            let desktopId = app.get_id();
            let info = Gio.DesktopAppInfo.new(desktopId);
            return info.get_categories() || [];
        } catch {
            return [];
        }
    }

    sortApps() {
        const overview = Main.overview;
        const view = overview.viewSelector._views[1];
        const items = view._grid._listItems;

        // group by category
        const groups = { office: [], games: [], development: [], utilities: [], other: [] };
        items.forEach(item => {
            const app = item.app;
            const cats = this.getAppCategories(app).map(c => c.toLowerCase());
            let key = 'other';
            if (cats.includes('office')) key = 'office';
            else if (cats.includes('game')) key = 'games';
            else if (cats.includes('development')) key = 'development';
            else if (cats.includes('utility') || cats.includes('system')) key = 'utilities';
            groups[key].push(item);
        });

        // sort each group
        const order = ['office', 'games', 'development', 'utilities', 'other'];
        let sorted = [];
        order.forEach(k => {
            groups[k].sort((a, b) => a.app.get_name().localeCompare(b.app.get_name()));
            sorted = sorted.concat(groups[k]);
        });

        // rebuild grid
        const grid = view._grid;
        grid._clear();
        sorted.forEach(item => grid._addItem(item));
    }

    enable() {
        this._overviewId = Main.overview.connect('showing', () => this.sortApps());
    }

    disable() {
        if (this._overviewId) Main.overview.disconnect(this._overviewId);
    }
}

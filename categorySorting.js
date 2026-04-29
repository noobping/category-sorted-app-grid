import Gio from 'gi://Gio';

import { formatError, logDebug } from './logging.js';

const IGNORE_CATEGORIES = ['GTK', 'Qt', 'X-GNOME-Settings-Panel', 'GNOME'];

export function buildCategoryPositions(appDisplay, loadedIcons) {
    const icons = (Array.isArray(loadedIcons) ? loadedIcons : [])
        .filter(icon => icon && icon !== appDisplay._placeholder);
    const context = buildCategoryContext(icons);
    const orderedIcons = [...icons].sort((a, b) => compareIcons(a, b, context));
    const itemsPerPage = getItemsPerPage(appDisplay, orderedIcons.length);
    const positions = new Map();

    orderedIcons.forEach((icon, index) => {
        positions.set(icon.id, [
            Math.floor(index / itemsPerPage),
            index % itemsPerPage,
        ]);
    });

    const categories = [...new Set(orderedIcons
        .filter(icon => icon.app)
        .map(icon => chooseCategory(icon, context)))];

    return { positions, categories };
}

function getItemsPerPage(appDisplay, fallbackCount) {
    const itemsPerPage = appDisplay._grid?.itemsPerPage;

    if (Number.isFinite(itemsPerPage) && itemsPerPage > 0)
        return itemsPerPage;

    return Math.max(fallbackCount || 1, 1);
}

function buildCategoryContext(icons) {
    const categoriesById = new Map();
    const categoryCounts = new Map();

    for (const icon of icons) {
        if (!icon.app)
            continue;

        const categories = getAppCategories(icon.app);
        categoriesById.set(icon.id, categories);

        for (const category of categories)
            categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    }

    return { categoriesById, categoryCounts };
}

function compareIcons(a, b, context) {
    const aIsFolder = !a.app;
    const bIsFolder = !b.app;

    if (aIsFolder !== bIsFolder)
        return aIsFolder ? 1 : -1;

    if (!aIsFolder) {
        const categoryCompare =
            chooseCategory(a, context).localeCompare(chooseCategory(b, context));
        if (categoryCompare !== 0)
            return categoryCompare;
    }

    return getIconName(a).localeCompare(getIconName(b));
}

function chooseCategory(icon, context) {
    const categories = context.categoriesById.get(icon.id) || ['Other'];

    return categories.reduce((bestCategory, currentCategory) => {
        const bestCount = context.categoryCounts.get(bestCategory) || 0;
        const currentCount = context.categoryCounts.get(currentCategory) || 0;

        if (currentCount > bestCount)
            return currentCategory;
        if (currentCount === bestCount && currentCategory.localeCompare(bestCategory) < 0)
            return currentCategory;

        return bestCategory;
    }, categories[0]);
}

function getAppCategories(app) {
    let categories = [];

    try {
        const info = app.get_app_info
            ? app.get_app_info()
            : Gio.DesktopAppInfo.new(app.get_id());
        let categoriesString = info ? info.get_categories() : null;

        if (categoriesString) {
            categoriesString = categoriesString.trim();
            if (categoriesString.endsWith(';'))
                categoriesString = categoriesString.slice(0, -1);
            categories = categoriesString.split(';').filter(category => category.length > 0);
        }
    } catch (e) {
        const appId = app.get_id ? app.get_id() : 'unknown app';
        logDebug(`Error reading categories for ${appId}: ${formatError(e)}`);
    }

    if (categories.length === 0)
        categories = ['Other'];

    const filteredCategories = categories.filter(category => !IGNORE_CATEGORIES.includes(category));
    return filteredCategories.length > 0 ? filteredCategories : categories;
}

function getIconName(icon) {
    return icon.name || icon.id || '';
}

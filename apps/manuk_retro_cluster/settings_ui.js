'use strict';
// Genuine RHMI list/checkbox controls. ConfigStore is the only persisted settings owner.
const diagnosticValues = require('./diagnostic_values');
const LABELS = {
    ru: {
        title: 'Retro Cluster', enabled: 'Включить приборку', engine: 'Включать при запуске двигателя',
        engineNote: 'После выключения автомобиля нужен ручной запуск приложения.', language: 'Язык', units: 'Единицы измерения',
        engineNoteAuto: 'Приложение запускается автоматически. Отображение можно выключить настройкой «Включить приборку».',
        speed: 'Скорость', temperature: 'Температура', pressure: 'Давление', consumption: 'Расход', back: 'Назад',
        saveError: 'Не удалось сохранить настройки. Проверьте журнал приложения.', screenError: 'Не удалось открыть экран настроек.',
        kmh: 'км/ч', mph: 'миль/ч', c: '°C', f: '°F', bar: 'бар', psi: 'psi', l100km: 'л/100 км', mpg: 'mpg (US)',
        diagnostics: 'Проверка данных', diagNote: 'Только чтение данных. Проверяйте на стоящем автомобиле. Ничего не отправляется автоматически.',
        diagBench: 'ИМИТАЦИЯ ДАННЫХ — локальный стенд. Это не показания автомобиля.',
        diagIdle: 'Готово к сбору. Отчёт хранится локально в приложении.', diagCollecting: 'Сбор данных: ', diagSeconds: ' из 30 с',
        diagComplete: 'Сбор завершён. Откройте значения и сфотографируйте нужные страницы.', diagCancelled: 'Сбор отменён.',
        diagPartial: 'Доступны значения частичного отчёта.', diagSaveError: 'Локальный файл не сохранён. Значения доступны на экране.',
        diagError: 'Не удалось собрать отчёт. Подробности в журнале приложения.', diagUnavailable: 'Сбор данных недоступен в этой версии.',
        diagStart: 'Собрать данные · 30 с', diagCancel: 'Отменить сбор', diagValues: 'Показать значения', valuesTitle: 'Значения отчёта',
        valuesPrev: 'Предыдущая', valuesNext: 'Следующая'
    },
    en: {
        title: 'Retro Cluster', enabled: 'Enable cluster display', engine: 'Enable when the engine starts',
        engineNote: 'After the vehicle switches off, start the app manually.', language: 'Language', units: 'Units',
        engineNoteAuto: 'The app starts automatically. Turn off “Enable cluster display” to disable its display.',
        speed: 'Speed', temperature: 'Temperature', pressure: 'Pressure', consumption: 'Consumption', back: 'Back',
        saveError: 'Could not save settings. Check the application log.', screenError: 'Could not open the settings screen.',
        kmh: 'km/h', mph: 'mph', c: '°C', f: '°F', bar: 'bar', psi: 'psi', l100km: 'l/100 km', mpg: 'mpg (US)',
        diagnostics: 'Check vehicle data', diagNote: 'Read-only collection. Check while parked. Nothing is sent automatically.',
        diagBench: 'SIMULATED DATA — local bench. These are not readings from the car.',
        diagIdle: 'Ready to collect. The report is stored locally in the app.', diagCollecting: 'Collecting data: ', diagSeconds: ' of 30 s',
        diagComplete: 'Collection complete. Open the values and photograph the pages you need.', diagCancelled: 'Collection cancelled.',
        diagPartial: 'Values from a partial report are available.', diagSaveError: 'The local file was not saved. Values are available on screen.',
        diagError: 'Could not collect a report. Check the application log.', diagUnavailable: 'Data collection is unavailable in this version.',
        diagStart: 'Collect data · 30 s', diagCancel: 'Cancel collection', diagValues: 'Show values', valuesTitle: 'Report values',
        valuesPrev: 'Previous', valuesNext: 'Next'
    }
};
const UNITS = { speed: ['kmh', 'mph'], temperature: ['c', 'f'], pressure: ['bar', 'psi'], consumption: ['l100km', 'mpg'] };
const UNIT_IDS = { speed: 'UNIT_SPEED', temperature: 'UNIT_TEMPERATURE', pressure: 'UNIT_PRESSURE', consumption: 'UNIT_CONSUMPTION' };
const DIAGNOSTIC_REASONS = {
    'vehicle-moving': ['Сбор остановлен: автомобиль движется.', 'Collection stopped: the vehicle is moving.'],
    'selector-not-P': ['Сбор остановлен: селектор не в положении P.', 'Collection stopped: the selector is not in P.'],
    'vehicle-not-active': ['Сбор остановлен: автомобиль неактивен.', 'Collection stopped: the vehicle is inactive.'],
    'speed-unknown': ['Не удалось подтвердить нулевую скорость.', 'Zero speed could not be confirmed.'],
    'selector-unknown': ['Не удалось подтвердить положение P.', 'The P selector position could not be confirmed.'],
    'vehicle-condition-unknown': ['Нет подтверждённого состояния автомобиля.', 'The vehicle state is not confirmed.'],
    'guard-provider-unavailable': ['Источник скорости, селектора или состояния автомобиля недоступен.', 'The speed, selector or vehicle state source is unavailable.'],
    'guard-epoch-ended': ['Сбор остановлен: источник данных перезапущен или автомобиль уснул.', 'Collection stopped: a data source restarted or the vehicle went to sleep.'],
    'vehicle-source-unavailable': ['Источник автомобильных данных недоступен.', 'The vehicle data source is unavailable.'],
    'parked-guard-unavailable': ['Не удалось подтвердить неподвижность и положение P.', 'A stationary vehicle and selector P could not be confirmed.'],
    'signal-reader-unavailable': ['Интерфейс чтения сигналов недоступен.', 'The signal reader is unavailable.']
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const STATUS = {
    'not started': ['Ожидание запуска приложения', 'Waiting for the app to start'],
    'disabled in configuration': ['Отображение выключено', 'Display disabled'],
    'waiting for active vehicle state': ['Ожидание готовности автомобиля', 'Waiting for the vehicle'],
    'waiting for confirmed engine state': ['Ожидание данных о двигателе', 'Waiting for engine data'],
    'waiting for engine start': ['Ожидание запуска двигателя', 'Waiting for the engine to start'],
    'speed unavailable': ['Ожидание данных скорости', 'Waiting for speed data'],
    'gear unavailable or ambiguous': ['Ожидание данных передачи', 'Waiting for gear data'],
    'own rendering disabled; verify the stock display': ['Отображение выключено. Проверьте штатную приборку.', 'Display disabled. Check the original cluster.'],
    'stopped; own layers released, verify the stock display': ['Приложение остановлено. Проверьте штатную приборку.', 'App stopped. Check the original cluster.']
};
function status(value, language) {
    const raw = String(value || '').replace(/; own layers released$/, ''), en = language === 'en';
    if (STATUS[raw]) return STATUS[raw][en ? 1 : 0];
    if (/refused|could not start|exceeds|error/i.test(raw)) return en ? 'Display unavailable. Check the application log.' : 'Отображение недоступно. Проверьте журнал приложения.';
    if (/connecting|waiting|parked|suspended|stalled|not installed|not running/.test(raw)) return en ? 'Waiting for the instrument cluster' : 'Ожидание готовности приборной панели';
    if (/ on: /.test(raw)) return en ? 'Application running' : 'Приложение работает';
    return en ? 'Waiting for status' : 'Ожидание состояния приложения';
}

function attach(ctx, controller) {
    const ui = ctx.ui, store = controller.store, log = ctx.log || {};
    const autostart = !!(ctx.spec && ctx.spec.mguAppStartType === 'autostart');
    if (!ui || !store) throw new Error('Settings require RHMI and ConfigStore');
    const diagnostics = controller.diagnostics;
    let stopped = false, error = null, diagnosticError = null, currentStatus = controller.currentStatus, valuesPage = 0;
    let refreshQueue = Promise.resolve(), actionQueue = Promise.resolve();
    const diagnosticState = () => diagnostics && diagnostics.snapshot ? diagnostics.snapshot() : { state: 'unavailable', report: null };
    function refreshDiagnostics(t) {
        const d = diagnosticState(), collecting = d.state === 'collecting', formatted = diagnosticValues.format(d.report, store.current.language);
        const pages = formatted.pages;
        const exportable = ['complete', 'cancelled', 'error'].indexOf(d.state) >= 0 && pages.length > 0;
        const simulation = formatted.simulation || d.simulation === true || controller.profile === 'bench';
        let stateText = d.state === 'collecting' ? t.diagCollecting + Math.max(0, Math.min(30, Math.floor(d.elapsedSeconds || 0))) + t.diagSeconds
            : t[{ idle: 'diagIdle', complete: 'diagComplete', cancelled: 'diagCancelled', error: 'diagError', unavailable: 'diagUnavailable' }[d.state] || 'diagError'];
        const reason = d.error || d.reason || d.report && d.report.reason;
        if ((d.state === 'error' || d.state === 'cancelled') && DIAGNOSTIC_REASONS[reason]) stateText = DIAGNOSTIC_REASONS[reason][store.current.language === 'en' ? 1 : 0];
        if (d.error === 'report-save-failed') stateText = t.diagSaveError;
        else if (exportable && d.state !== 'complete') stateText += ' ' + t.diagPartial;
        valuesPage = Math.max(0, Math.min(valuesPage, Math.max(0, pages.length - 1)));
        const page = exportable ? pages[valuesPage] : null;
        const jobs = [ui.text('DIAGNOSTICS_TITLE', t.diagnostics), ui.text('DIAG_NOTE', simulation ? t.diagBench + '\n' + t.diagNote : t.diagNote),
            ui.text('DIAG_STATUS', diagnosticError ? t[diagnosticError] : stateText), ui.text('DIAG_START', t.diagStart), ui.text('DIAG_CANCEL', t.diagCancel),
            ui.text('DIAG_SHOW_VALUES', t.diagValues), ui.text('DIAG_BACK', t.back), ui.enabled('DIAG_START', !!diagnostics && !collecting),
            ui.enabled('DIAG_CANCEL', collecting), ui.enabled('DIAG_SHOW_VALUES', exportable),
            ui.text('DIAGNOSTIC_VALUES_TITLE', (page && page.title || t.valuesTitle) + ' ' + (valuesPage + 1) + '/' + (pages.length || 1) + (simulation ? ' · ' + (store.current.language === 'en' ? 'SIMULATION' : 'ИМИТАЦИЯ') : '')),
            ui.text('DIAG_VALUES_PREV', t.valuesPrev), ui.text('DIAG_VALUES_NEXT', t.valuesNext), ui.text('DIAG_VALUES_BACK', t.back),
            ui.enabled('DIAG_VALUES_PREV', exportable && valuesPage > 0), ui.enabled('DIAG_VALUES_NEXT', exportable && valuesPage < pages.length - 1)];
        for (let i = 0; i < 4; i++) {
            const row = page && page.rows[i], name = 'DIAG_VALUE_' + (i + 1);
            jobs.push(ui.cells(name, 0, { Text1stRow: row ? row.label : '', Text2ndRow: row ? row.value : '' }), ui.visible(name, !!row));
        }
        return Promise.all(jobs);
    }
    function refresh() {
        refreshQueue = refreshQueue.catch(() => {}).then(() => {
            if (stopped) return;
            const c = store.current, t = LABELS[c.language] || LABELS.ru, units = c.displayUnits;
            const jobs = [
                ui.text('MAIN_TITLE', t.title), ui.text('LANGUAGE_TITLE', t.language), ui.text('UNITS_TITLE', t.units),
                ui.text('BTN_DIAGNOSTICS', t.diagnostics),
                ui.text('SET_ENABLED', t.enabled), ui.checked('SET_ENABLED', c.enabled === true),
                ui.text('SET_ENGINE_START', t.engine), ui.checked('SET_ENGINE_START', c.startup.onEngineStart === true),
                ui.text('ENGINE_START_NOTE', autostart ? t.engineNoteAuto : t.engineNote),
                ui.cells('BTN_LANGUAGE', 0, { Text1stCol: t.language, Text2ndCol: c.language === 'en' ? 'English' : 'Русский' }),
                ui.cells('BTN_UNITS', 0, { Text1stCol: t.units, Text2ndCol: [t[units.speed], t[units.temperature], t[units.pressure]].join(' · ') }),
                ui.text('LANG_RU', 'Русский'), ui.checked('LANG_RU', c.language === 'ru'),
                ui.text('LANG_EN', 'English'), ui.checked('LANG_EN', c.language === 'en'),
                ui.text('BTN_LANGUAGE_BACK', t.back), ui.text('BTN_UNITS_BACK', t.back),
                ui.text('SETTINGS_STATUS', error ? t[error] : status(currentStatus, c.language))
            ];
            Object.keys(UNITS).forEach((key) => jobs.push(ui.cells(UNIT_IDS[key], 0, { Text1stCol: t[key], Text2ndCol: t[units[key]] })));
            jobs.push(refreshDiagnostics(t));
            return Promise.all(jobs);
        }).catch(() => { if (log.warn) log.warn('settings screen update failed'); });
        return refreshQueue;
    }
    function action(fn, failure) {
        actionQueue = actionQueue.catch(() => {}).then(() => {
            if (stopped) return;
            return Promise.resolve().then(fn).then(() => { error = null; }, () => {
                error = failure || 'saveError';
                if (log.error) log.error(error === 'saveError' ? 'settings persistence failed' : 'settings screen navigation failed');
            });
        }).then(refresh);
        return actionQueue;
    }
    const bind = (id, fn, failure) => ui.onClick(id, () => action(fn, failure));
    const save = (edit) => { const next = copy(store.current); edit(next); store.save(next); };
    bind('SET_ENABLED', () => controller.setEnabled(store.current.enabled !== true));
    bind('SET_ENGINE_START', () => controller.setEngineStart(store.current.startup.onEngineStart !== true));
    bind('BTN_LANGUAGE', () => ui.open('LANGUAGE'), 'screenError');
    bind('BTN_UNITS', () => ui.open('UNITS'), 'screenError');
    bind('BTN_DIAGNOSTICS', () => ui.open('DIAGNOSTICS'), 'screenError');
    bind('DIAG_BACK', () => ui.close('DIAGNOSTICS'), 'screenError');
    bind('DIAG_START', () => {
        if (!diagnostics || diagnosticState().state === 'collecting') return;
        diagnosticError = null; valuesPage = 0;
        // A collector may expose a promise for completion; never block Cancel behind that promise.
        const job = diagnostics.start();
        if (job && job.catch) job.catch(() => { if (!stopped) { diagnosticError = 'diagError'; refresh(); } });
    });
    bind('DIAG_CANCEL', () => { if (diagnostics) diagnostics.cancel(); });
    bind('DIAG_SHOW_VALUES', () => {
        const d = diagnosticState(), pages = diagnosticValues.format(d.report, store.current.language).pages;
        if (['complete', 'cancelled', 'error'].indexOf(d.state) < 0 || !pages.length) return;
        diagnosticError = null; valuesPage = 0; return ui.open('DIAGNOSTIC_VALUES');
    }, 'screenError');
    bind('DIAG_VALUES_PREV', () => { if (valuesPage > 0) valuesPage--; });
    bind('DIAG_VALUES_NEXT', () => { const pages = diagnosticValues.format(diagnosticState().report, store.current.language).pages; if (valuesPage + 1 < pages.length) valuesPage++; });
    bind('DIAG_VALUES_BACK', () => ui.close('DIAGNOSTIC_VALUES'), 'screenError');
    bind('BTN_LANGUAGE_BACK', () => ui.close('LANGUAGE'), 'screenError');
    bind('BTN_UNITS_BACK', () => ui.close('UNITS'), 'screenError');
    ['ru', 'en'].forEach((language) => bind('LANG_' + language.toUpperCase(), () => {
        if (store.current.language !== language) save((next) => { next.language = language; });
    }));
    Object.keys(UNITS).forEach((key) => bind(UNIT_IDS[key], () => save((next) => {
        const options = UNITS[key];
        next.displayUnits[key] = options[(options.indexOf(next.displayUnits[key]) + 1) % options.length];
    })));
    const off = store.onChange(() => { refresh(); });
    const offStatus = controller.onStatus ? controller.onStatus((value) => { currentStatus = value; refresh(); }) : null;
    const offDiagnostics = diagnostics && diagnostics.onChange ? diagnostics.onChange(() => {
        if (stopped) return;
        refreshQueue = refreshQueue.catch(() => {}).then(() => { if (!stopped) return refreshDiagnostics(LABELS[store.current.language] || LABELS.ru); })
            .catch(() => { if (log.warn) log.warn('diagnostic screen update failed'); });
    }) : null;
    if (ui.onVisible) ui.onVisible((name, visible) => {
        if (!stopped && visible && ['MAIN', 'LANGUAGE', 'UNITS', 'DIAGNOSTICS', 'DIAGNOSTIC_VALUES'].indexOf(name) >= 0) refresh();
    });
    return { ready: refresh(), refresh: refresh, stop: () => { if (stopped) return; stopped = true; if (off) off(); if (offStatus) offStatus(); if (offDiagnostics) offDiagnostics(); } };
}

module.exports = { attach, LABELS, UNITS, status };

'use strict';
// Pure presentation of the scoped diagnostic report. No SDK, filesystem,
// timers, polling, conversion, calibration or inferred vehicle states.
const MAX_ROWS = 4, MAX_PAGES = 64, TEXT_CHUNK = 48;
const SOURCES = [
    { id: 'tank', interface: 'de.bmw.infotainment.KombiIF', field: 'statusRangeTankStatus',
        ru: 'Топливо · KombiIF', en: 'Fuel · KombiIF', members: [['fluidLevelFuelTank', 'Топливо', 'Fuel'], ['range', 'Запас хода', 'Range']] },
    { id: 'bc', interface: 'de.bmw.infotainment.KombiIF', field: 'statusBordcomputerAverage',
        ru: 'Расход · BC1 / BC2', en: 'Consumption · BC1 / BC2', members: [['consumptionAverage1BC1', 'Средний BC1', 'Average BC1'], ['consumptionAverage2BC2', 'Средний BC2', 'Average BC2'], ['statusUnitOfMeasurementConsumptionBC', 'Код единиц BC', 'BC unit code']] },
    { id: 'boost', interface: 'de.bmw.infotainment.drivingexcitement.FES', field: 'statusSwitchDriveDynamicSport2',
        ru: 'Наддув · FES', en: 'Boost · FES', members: [['displayBoostPressure', 'Наддув', 'Boost'], ['displayMaximumValueBoostPressure', 'Максимум шкалы', 'Display maximum']] },
    { id: 'dsc', interface: 'de.bmw.chassis.VehicleStabilizationManagement', field: 'StabilizationManagement',
        ru: 'Стабилизация · DSC', en: 'Stabilization · DSC', members: [['qualifierFunctionFDR', 'DSC / FDR', 'DSC / FDR'], ['qualifierFunctionASC', 'ASC', 'ASC'], ['qualifierFunctionABS', 'ABS', 'ABS']] },
    { id: 'injection', interface: 'de.bmw.infotainment.vehicle.CDS2', field: 'statusInjectionVolume',
        ru: 'Расход · впрыск CDS2', en: 'Consumption · injection CDS2', members: [['injectionVolumeFuelEngine', 'Впрыск raw', 'Injection raw'], ['oilTemperature', 'Масло raw CDS2', 'Oil raw CDS2']] },
    { id: 'current', interface: 'de.bmw.infotainment.resetlogic.ResetLogic', field: 'currentConsumption',
        ru: 'Расход · ResetLogic текущий', en: 'Consumption · ResetLogic current', dynamic: true },
    { id: 'average', interface: 'de.bmw.infotainment.resetlogic.ResetLogic', field: 'averageConsumption',
        ru: 'Расход · ResetLogic средний', en: 'Consumption · ResetLogic average', dynamic: true },
];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const finite = (v) => typeof v === 'number' && isFinite(v);
const privateName = (s) => /vin|vehicleidentification|serial|identif|(?:^|[._:])id(?:$|[._:]|[A-Z])|position|latitude|longitude|location|mileage|odometer|password|secret|token|credential|key|account|email|username/i.test(s);
const identifier = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$/.test(s) && !privateName(s) && !/^[A-HJ-NPR-Z0-9]{17}$/.test(s) && !/^(?:__proto__|prototype|constructor)$/.test(s);
const primitive = (type) => /^(?:u?int(?:8|16|32|64)?|float(?:32|64)?|double|byte|boolean|bool)$/i.test(type || '');
function exact(value, missing) {
    if (finite(value)) return value === 0 && 1 / value === -Infinity ? '-0' : String(value);
    if (typeof value === 'boolean') return String(value);
    if (identifier(value)) return value;
    return missing;
}
const REASONS = {
    'duration-complete': ['30 секунд завершены', '30 seconds completed'],
    'cancelled-by-user': ['Остановлено вручную', 'Stopped manually'],
    'vehicle-source-unavailable': ['Источник автомобиля недоступен', 'Vehicle source unavailable'],
    'guard-provider-unavailable': ['Потерян источник условий сбора', 'Collection guard source unavailable'],
    'vehicle-not-active': ['Автомобиль не активен', 'Vehicle is inactive'],
    'vehicle-condition-unknown': ['Состояние автомобиля неизвестно', 'Vehicle condition unknown'],
    'selector-not-P': ['Селектор не в P', 'Selector is not in P'],
    'selector-unknown': ['Положение селектора неизвестно', 'Selector position unknown'],
    'vehicle-moving': ['Автомобиль движется', 'Vehicle is moving'],
    'speed-unknown': ['Скорость неизвестна', 'Speed unknown'],
    'guard-epoch-ended': ['Сеанс источника завершён', 'Source session ended'],
    'parked-guard-unavailable': ['Стоянка не подтверждена', 'Parked state unconfirmed'],
    'signal-reader-unavailable': ['Чтение сигналов недоступно', 'Signal reader unavailable'],
    'no-safe-catalog-members': ['Нет разрешённых полей в каталоге', 'No allowed catalog members'],
    'not-observed': ['Ответы ещё не получены', 'No observations received'],
    'raw-only-unverified': ['Сырые коды; смысл не подтверждён', 'Raw codes; meaning unverified'],
    'no-safe-values-in-observation': ['В последнем ответе нет допустимых значений', 'No allowed values in latest response'],
    'subscription-unavailable': ['Подписка недоступна', 'Subscription unavailable'],
    'subscription-failed': ['Подписка не создана', 'Subscription failed'],
};
function format(report, language) {
    const ru = language !== 'en', tr = (a, b) => ru ? a : b;
    const missing = tr('нет данных', 'no data');
    const out = { pages: [], simulation: !!(report && (report.environment === 'bench' || report.simulation === true)) };
    if (!object(report)) return out;
    const row = (label, value) => ({ label: label, value: String(value) });
    const reason = (code) => own(REASONS, code) ? REASONS[code][ru ? 0 : 1] : missing;
    function appendText(rows, label, value) {
        const text = String(value), chunks = text.match(new RegExp('.{1,' + TEXT_CHUNK + '}', 'g')) || [''];
        chunks.forEach((s, i) => rows.push(row(label + (chunks.length > 1 ? ' (' + (i + 1) + '/' + chunks.length + ')' : ''), s)));
    }
    function addPages(target, title, rows) {
        for (let i = 0; i < rows.length; i += MAX_ROWS) target.push({ title: title, rows: rows.slice(i, i + MAX_ROWS) });
    }
    const md = object(report.metadata) ? report.metadata : {}, fields = Array.isArray(md.fields) ? md.fields : [];
    const stateNames = { complete: tr('Завершено', 'Complete'), cancelled: tr('Отменено', 'Cancelled'), error: tr('Ошибка', 'Error'), collecting: tr('Сбор не завершён', 'Collection incomplete') };
    const metadataNames = { available: md.incomplete ? tr('Частичный каталог', 'Partial catalog') : tr('Доступен', 'Available'),
        missing: tr('Отсутствует', 'Missing'), limited: tr('Не прочитан: лимит размера', 'Not read: size limit'), invalid: tr('Неверный формат', 'Invalid format'), unavailable: tr('Недоступен', 'Unavailable') };
    const summary = [
        row(tr('Состояние / длительность, с', 'State / duration, s'), (stateNames[report.state] || missing) + ' / ' + exact(report.elapsedSeconds, missing)),
        row(tr('Причина завершения', 'Completion reason'), reason(report.reason)),
        row(tr('Режим данных', 'Data environment'), out.simulation ? tr('ИМИТАЦИЯ ДАННЫХ', 'SIMULATION DATA') : tr('Наблюдения; ещё не расшифрованы', 'Observations; not yet decoded')),
        row(tr('Каталог типов и enum', 'Types and enum catalog'), metadataNames[md.status] || missing),
        row(tr('Единицы и смысл кодов', 'Units and code meanings'), tr('Не предполагаются по числам', 'Never inferred from numbers')),
        row(tr('Полнота отображения', 'Display completeness'), tr('Все выбранные строки показаны', 'All selected rows shown')),
    ];
    addPages(out.pages, tr('Диагностика · сводка', 'Diagnostics · summary'), summary);
    const tables = [], tableKeys = {};
    SOURCES.forEach((scope) => {
        const s = object(report.sources) && object(report.sources[scope.id]) ? report.sources[scope.id] : {};
        const field = fields.filter((f) => object(f) && f.interface === scope.interface && f.field === scope.field)[0];
        const members = field && Array.isArray(field.members) ? field.members.filter((m) => object(m) && !m.array && Array.isArray(m.path) && m.path.length > 0 && m.path.every(identifier)) : [];
        const sourceRows = [row(tr('Доступность источника / ответов', 'Provider availability / observations'),
            (s.available === true ? tr('доступен', 'available') : tr('нет данных', 'no data')) + ' / ' + exact(s.observations, '0')),
        row(tr('Качество / причина', 'Quality / reason'), reason(s.reason))];
        if (s.truncated || s.omittedPaths) sourceRows.push(row(tr('Не собраны поля: лимит', 'Fields not collected: limit'), exact(s.omittedPaths, missing)));
        let selected;
        if (scope.dynamic) {
            // A report's arbitrary keys never authorize display. Only paths
            // selected by the collector AND typed by scoped metadata qualify.
            const paths = Array.isArray(s.paths) ? s.paths.slice(0, 12) : [];
            selected = paths.filter((p) => Array.isArray(p) && p.length > 0 && p.length <= 8 && p.every(identifier) && p.join('.').length <= 160 &&
                members.some((m) => m.path.join('.') === p.join('.') && (primitive(m.type) || m.type === 'enum')))
                .map((p, i) => [p.join('.'), tr('Поле ', 'Field ') + (i + 1), tr('Field ', 'Field ') + (i + 1)]);
        } else selected = scope.members;
        if (!selected.length) sourceRows.push(row(tr('Разрешённые значения', 'Allowed values'), missing));
        selected.forEach((spec) => {
            const name = spec[0], short = spec[ru ? 1 : 2], label = scope.dynamic ? short : short + ' · ' + name;
            let current = object(s.latest) && own(s.latest, name) ? s.latest[name] : undefined;
            const stat = object(s.stats) && own(s.stats, name) && object(s.stats[name]) ? s.stats[name] : {};
            const meta = members.filter((m) => m.path.join('.') === name)[0];
            const en = meta && Array.isArray(meta.enum) ? meta.enum.filter((e) => object(e) && identifier(e.name) && finite(e.value) && Number.isSafeInteger(e.value)).slice(0, 128) : [];
            const display = (value) => {
                if (typeof value === 'string' && (scope.dynamic ? !en.some((e) => e.name === value) : scope.id !== 'dsc' && name !== 'statusUnitOfMeasurementConsumptionBC')) return missing;
                return exact(value, missing);
            };
            if (scope.dynamic && typeof current === 'string' && !en.some((e) => e.name === current)) current = undefined;
            if (scope.dynamic || label.length > TEXT_CHUNK) appendText(sourceRows, short + tr(' · имя', ' · name'), name);
            appendText(sourceRows, scope.dynamic || label.length > TEXT_CHUNK ? short : label, display(current));
            const matches = en.filter((e) => current === e.value || current === e.name);
            matches.forEach((e) => appendText(sourceRows, short + ' · enum', String(e.value) + ' = ' + e.name));
            const counter = scope.id === 'injection' && name === 'injectionVolumeFuelEngine';
            if (counter || stat.first !== stat.latest) appendText(sourceRows, short + tr(' · первое raw', ' · first raw'), display(stat.first));
            if (counter || finite(stat.min) && finite(stat.max) && stat.min !== stat.max) sourceRows.push(row(short + ' · min / max', exact(stat.min, missing) + ' / ' + exact(stat.max, missing)));
            if (counter || finite(stat.count) && stat.count !== s.observations) sourceRows.push(row(short + tr(' · число значений', ' · value count'), exact(stat.count, missing)));
            if (counter) sourceRows.push(row(tr('Впрыск · первое / последнее, мс', 'Injection · first / last, ms'), exact(stat.firstMs, missing) + ' / ' + exact(stat.latestMs, missing)));
            // If the latest response omitted a member, keep that lack of data
            // visible; an earlier observation is explicitly historical.
            if ((current === undefined || current === null) && stat.latest !== undefined && stat.latest !== null) appendText(sourceRows,
                short + tr(' · последнее ранее raw', ' · earlier last raw'), display(stat.latest));
            const fullTable = scope.id === 'dsc' || scope.id === 'bc' && name === 'statusUnitOfMeasurementConsumptionBC' ||
                scope.dynamic && (/unit|measurement/i.test(name) || meta && /unit|measurement/i.test(meta.dataRef || ''));
            if (fullTable) {
                if (!en.length) sourceRows.push(row(short + tr(' · таблица enum', ' · enum table'), missing));
                else {
                    const sorted = en.slice().sort((a, b) => a.value - b.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
                    const key = JSON.stringify(sorted);
                    if (!own(tableKeys, key)) { tableKeys[key] = tables.length; tables.push({ entries: sorted, uses: [] }); }
                    tables[tableKeys[key]].uses.push(scope.id + '.' + name);
                }
            }
        });
        addPages(out.pages, scope[ru ? 'ru' : 'en'], sourceRows);
    });
    const enumPages = [];
    tables.forEach((table, i) => {
        const rows = [];
        table.uses.forEach((name) => appendText(rows, tr('Таблица для поля', 'Table for member'), name));
        table.entries.forEach((entry) => appendText(rows, tr('Код ', 'Code ') + String(entry.value), entry.name));
        addPages(enumPages, tr('Таблица enum ', 'Enum table ') + (i + 1) + tr(' · из каталога', ' · from catalog'), rows);
    });
    const rawPages = out.pages.length;
    let omittedRows = 0;
    enumPages.forEach((page) => {
        if (out.pages.length < MAX_PAGES) out.pages.push(page);
        else omittedRows += page.rows.length;
    });
    // Collector bounds keep raw pages below this limit; malformed external
    // reports get an explicit notice rather than unbounded UI generation.
    if (out.pages.length > MAX_PAGES) {
        out.pages.slice(MAX_PAGES).forEach((p) => { omittedRows += p.rows.length; });
        out.pages = out.pages.slice(0, MAX_PAGES);
    }
    const capturedLimited = report.truncated === true || md.incomplete === true;
    summary[5].value = omittedRows ? tr('Не показано строк: ', 'Rows not shown: ') + omittedRows + tr('; лимит 64 страниц', '; 64-page limit') :
        capturedLimited ? tr('Показано всё собранное; сбор ограничен', 'All collected rows shown; collection limited') : tr('Все выбранные строки показаны', 'All selected rows shown');
    // Raw source pages precede optional enum tables, never the reverse.
    if (rawPages > MAX_PAGES) summary[5].value = tr('Слишком большой отчёт; не показано строк: ', 'Report too large; rows not shown: ') + omittedRows;
    return out;
}
module.exports = { format, MAX_ROWS, MAX_PAGES };

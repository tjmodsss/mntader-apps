'use strict';
// Presentation only: protocol values and the original diagnostic log remain unchanged.
const messages = {
    'not started': 'Приложение ещё не запущено',
    'disabled in configuration': 'Отображение выключено в конфигурации',
    'waiting for active vehicle state': 'Ожидание активного состояния автомобиля',
    'waiting for confirmed engine state': 'Ожидание подтверждённого состояния двигателя',
    'waiting for engine start': 'Ожидание запуска двигателя',
    'speed unavailable': 'Данные скорости недоступны',
    'gear unavailable or ambiguous': 'Данные передачи недоступны или неоднозначны',
    'own rendering disabled; verify the stock display': 'Отображение выключено; проверьте штатную приборку',
    'stopped; own layers released, verify the stock display': 'Приложение остановлено; его слои освобождены. Проверьте штатную приборку',
    'renderer refused a layer; disable and enable after checking the renderer': 'Сервис отрисовки отклонил слой. Проверьте сервис, затем выключите и включите отображение',
    'layout exceeds conservative renderer budget': 'Превышен допустимый бюджет слоёв или памяти отрисовки',
    'rendering could not start; inspect local logs and re-enable after correction': 'Не удалось запустить отрисовку. Проверьте журнал и включите отображение после исправления',
};
const states = {
    waiting: 'ожидают готовности', parked: 'перекрыты другим изображением',
    suspended: 'приостановлены', stalled: 'ожидают содержимого',
    error: 'с ошибкой', shown: 'отображаются',
};
function detail(text) {
    if (!text) return '';
    if (text.indexOf('waiting: another app has this display') >= 0) return '; экран занят другим приложением';
    if (text.indexOf('waiting: BMW is using this display') >= 0) return '; экран занят штатным интерфейсом BMW';
    const drawn = text.match(/(\d+) of (\d+) layers? drawn(?: \((\d+) (\w+)(?:: [^)]*)?\))?/);
    let out = drawn ? '; отображено слоёв: ' + drawn[1] + ' из ' + drawn[2] : '';
    if (drawn && drawn[3]) out += '; ' + drawn[3] + ' ' + (states[drawn[4]] || 'ожидают отображения');
    if (text.indexOf('refused ') >= 0) out += '; есть отклонённые слои — подробности в журнале';
    if (text.indexOf('playing the demo') >= 0) out += '; воспроизводится имитация данных';
    else if (text.indexOf('demo data') >= 0) out += '; имитация данных';
    return out || '; подробности состояния — в журнале';
}
function status(value) {
    const text = String(value || '');
    if (!text) return 'Ожидание состояния приложения';
    if (messages[text]) return messages[text];
    const released = '; own layers released';
    if (text.slice(-released.length) === released) return status(text.slice(0, -released.length)) + '; слои приложения освобождены';
    const label = 'Retro Cluster';
    if (/: connecting to cluster-render$/.test(text)) return label + ': подключение к сервису отрисовки';
    if (/ off: cluster-render is not installed or not running$/.test(text)) return label + ': сервис отрисовки не установлен или не запущен';
    if (/ off: BMW's own (?:cluster|HUD) shows$/.test(text)) return label + ': выключено; проверьте штатную приборку';
    const active = text.match(/^.+ on: .+ (?:theme|layout[^,]*), (\d+) layers?(?: on (\d+) connections)?(?:, ([\d.]+) MiB of 16 MiB pixels)?(.*)$/);
    if (active) {
        return label + ': включено; Ретро 80-х. Слои: ' + active[1] + '; соединения: ' + (active[2] || '1')
            + (active[3] ? '; память изображений: ' + active[3].replace('.', ',') + ' из 16 МиБ' : '') + detail(active[4]);
    }
    // Rendering/configuration errors are logged with their full original detail by the runtime.
    if (/^Retro Cluster: [А-Яа-яЁё]/.test(text)) return text;
    if (/^Retro Cluster: /.test(text)) return label + ': ошибка компоновки; подробности в журнале приложения';
    if (/[А-Яа-яЁё]/.test(text)) return text;
    return 'Состояние отрисовки изменилось; подробности в журнале приложения';
}
module.exports = { status };

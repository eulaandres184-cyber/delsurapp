const MONTHS = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export function formatCurrency(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? `$${Number(digits).toLocaleString('es-AR')}` : '';
}

export function formatEventDateLabel(days) {
    const dates = (days || []).map(day => day.date).filter(Boolean).sort();
    if (!dates.length) return 'Fecha a confirmar';

    const parsed = dates.map(date => {
        const [year, month, day] = date.split('-').map(Number);
        return year && month && day ? { year, month: month - 1, day } : null;
    }).filter(Boolean);
    if (!parsed.length) return 'Fecha a confirmar';

    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (parsed.length === 1) return `${first.day} ${MONTHS[first.month]} ${first.year}`;

    const sameMonth = first.month === last.month && first.year === last.year;
    if (parsed.length === 2) {
        return sameMonth
            ? `${first.day} y ${last.day} ${MONTHS[first.month]} ${first.year}`
            : `${first.day} ${MONTHS[first.month]} y ${last.day} ${MONTHS[last.month]} ${last.year}`;
    }
    return sameMonth
        ? `${first.day} al ${last.day} ${MONTHS[first.month]} ${first.year}`
        : `${first.day} ${MONTHS[first.month]} al ${last.day} ${MONTHS[last.month]} ${last.year}`;
}

export function formatEventDayLabel(date) {
    if (!date) return 'Fecha a confirmar';
    const parsedDate = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) return 'Fecha a confirmar';

    const label = new Intl.DateTimeFormat('es-AR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    }).format(parsedDate);
    return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isEventExpired(event, now = new Date()) {
    const dates = (event?.days || []).map(day => day.date).filter(Boolean).sort();
    if (!dates.length) return false;
    const today = now.toISOString().slice(0, 10);
    return dates[dates.length - 1] < today;
}

export function isMomentPast(date, time, now = new Date()) {
    if (!date) return false;
    const moment = new Date(`${date}T${time || '00:00'}`);
    return !Number.isNaN(moment.getTime()) && moment <= now;
}

export function isNumericLocationName(value) {
    return /^[+\-\d\s,./]+$/.test(String(value || '').trim());
}

export function getLocationName(data) {
    const address = data?.address || {};
    const street = address.road || address.pedestrian || address.footway || '';
    const streetAddress = [street, address.house_number].filter(Boolean).join(' ');
    const candidates = [
        data?.name,
        address.amenity,
        address.tourism,
        address.building,
        address.shop,
        address.leisure,
        streetAddress,
        ...(data?.display_name || '').split(',').map(part => part.trim())
    ];
    return candidates.find(name => name && !isNumericLocationName(name))?.trim() || '';
}

export function getGoogleMapsUrl(lat, lng) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

export function getAppleMapsUrl(lat, lng) {
    return `maps://?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

export function getMapCoordinates(url) {
    if (!url) return null;
    try {
        const parsedUrl = new URL(url);
        const query = decodeURIComponent(parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('q') || '');
        const match = query.match(/([-+]?\d+(?:\.\d+)?),\s*([-+]?\d+(?:\.\d+)?)/);
        return match ? { lat: Number(match[1]), lng: Number(match[2]) } : null;
    } catch (error) {
        return null;
    }
}

export function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
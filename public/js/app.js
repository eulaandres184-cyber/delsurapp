        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
        import { firebaseConfig, firebaseCollectionPath } from './firebase-config.js';
        import {
            formatCurrency,
            formatEventDateLabel,
            getAppleMapsUrl,
            getGoogleMapsUrl,
            getMapCoordinates,
            getLocationName,
            isEventExpired,
            isIOS,
            isMomentPast,
            isNumericLocationName
        } from './domain.js';
        import { googleMapsApiKey } from './google-maps-config.js';

        let eventsCollection = null;
        let storage = null;
        let authReadyPromise = null;
        let googleMapsPromise = null;
        // Centralized contact used by the floating button and event fallback.
        const adminWhatsAppPhone = '5491112345678';

        function loadGoogleMaps() {
            if (window.google?.maps) return Promise.resolve(window.google.maps);
            if (!googleMapsApiKey) return Promise.reject(new Error('Falta configurar la clave de Google Maps.'));
            if (googleMapsPromise) return googleMapsPromise;

            googleMapsPromise = new Promise((resolve, reject) => {
                const callbackName = `initGoogleMaps_${Date.now()}`;
                window[callbackName] = () => {
                    delete window[callbackName];
                    resolve(window.google.maps);
                };
                const script = document.createElement('script');
                script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleMapsApiKey)}&v=weekly&loading=async&callback=${callbackName}`;
                script.async = true;
                script.onerror = () => {
                    delete window[callbackName];
                    googleMapsPromise = null;
                    reject(new Error('No se pudo cargar Google Maps.'));
                };
                document.head.appendChild(script);
            });
            return googleMapsPromise;
        }

        function fileExtension(name, type) {
            const extension = name?.split('.').pop()?.toLowerCase();
            if (extension && extension !== name.toLowerCase()) return extension;
            return type === 'application/pdf' ? 'pdf' : 'jpg';
        }

        async function uploadMenuFile(file, eventId, dayIndex, meal) {
            if (!storage || !file) return null;
            await authReadyPromise;
            const extension = fileExtension(file.name, file.type);
            const storagePath = `menus/${eventId}/dia-${dayIndex + 1}-${meal}.${extension}`;
            const fileRef = ref(storage, storagePath);
            await uploadBytes(fileRef, file, { contentType: file.type || 'application/octet-stream' });
            return {
                name: file.name,
                type: file.type || 'application/octet-stream',
                src: await getDownloadURL(fileRef),
                storagePath
            };
        }

        async function migrateLegacyMenu(menu, eventId, dayIndex, meal) {
            if (!menu?.src?.startsWith('data:')) return menu;
            const response = await fetch(menu.src);
            const blob = await response.blob();
            const file = new File([blob], menu.name || `menu-${meal}.${fileExtension(menu.name, menu.type)}`, { type: menu.type || blob.type });
            return uploadMenuFile(file, eventId, dayIndex, meal);
        }

        function renderMenuContent(menu, fallbackText, label, detail = '') {
            const detailContent = detail.trim()
                ? `<p class="mt-2 text-sm text-slate-700 whitespace-pre-line bg-white p-3 rounded-xl border border-slate-200/60">${detail}</p>`
                : '';
            if (!menu?.src) {
                return fallbackText
                    ? `<p class="text-slate-700 whitespace-pre-line bg-white p-3 rounded-xl border border-slate-200/60">${fallbackText}</p>${detailContent}`
                    : `${detailContent || `<p class="text-[11px] text-slate-400 italic">${label} por definir</p>`}`;
            }

            if (menu.type === 'application/pdf' || menu.src.toLowerCase().includes('.pdf')) {
                return `<iframe src="${menu.src}" title="${label}" class="w-full h-80 rounded-xl border border-slate-200 bg-white"></iframe><a href="${menu.src}" target="_blank" class="mt-1 inline-block text-[11px] font-semibold text-slate-600 underline">Abrir PDF</a>${detailContent}`;
            }

            return `<img src="${menu.src}" alt="${label}" class="w-full max-h-[28rem] object-contain rounded-xl border border-slate-200 bg-white">${detailContent}`;
        }

        async function geocode(request) {
            await loadGoogleMaps();
            try {
                return await new google.maps.Geocoder().geocode(request);
            } catch (error) {
                const message = String(error?.message || error || '');
                if (message.includes('REQUEST_DENIED') || message.includes('not allowed to use the geocoder')) {
                    throw new Error('La clave de Google Maps no tiene habilitado Geocoding API o el dominio actual no está autorizado.');
                }
                throw error;
            }
        }

        // APP STATE
        window.state = {
            events: [],
            activeTab: 'events',
            isAdmin: false,
            adminPIN: '1234',
            headerTapCount: 0,
            headerTapTimer: null,
            adminSearch: '',
            adminFilterType: 'ALL',
            adminSortOrder: 'RECENT',
            currentMapCoords: null,
            mapInstance: null,
            mapMarker: null,
            editingEventId: null,
            currentLocationName: '',
            currentMapUrl: ''
        };

        // CAROUSEL DATA
        const carouselData = [
            {
                tag: 'Servicio Exclusivo',
                title: 'Menús Gourmet para Eventos Únicos',
                img: 'https://images.unsplash.com/photo-1555244162-803834f70033?auto=format&fit=crop&w=800&q=80'
            },
            {
                tag: 'Gastronomía de Autor',
                title: 'Almuerzos y Cenas Personalizadas',
                img: 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?auto=format&fit=crop&w=800&q=80'
            },
            {
                tag: 'Atención Profesional',
                title: 'Experiencias Culinarias Inolvidables',
                img: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=800&q=80'
            }
        ];

        let currentCarouselIndex = 0;
        let carouselInterval = null;

        window.carousel = {
            init: () => {
                const slidesContainer = document.getElementById('carousel-slides');
                const dotsContainer = document.getElementById('carousel-dots');
                if (!slidesContainer || !dotsContainer) return;

                slidesContainer.innerHTML = '';
                dotsContainer.innerHTML = '';

                carouselData.forEach((item, index) => {
                    const slide = document.createElement('div');
                    slide.className = `carousel-slide absolute inset-0 w-full h-full bg-cover bg-center transition-opacity duration-700 ${index === 0 ? 'opacity-100 z-10' : 'opacity-0 z-0'}`;
                    slide.style.backgroundImage = `url('${item.img}')`;
                    slidesContainer.appendChild(slide);

                    const dot = document.createElement('button');
                    dot.className = `w-2 h-2 rounded-full transition-all ${index === 0 ? 'bg-amber-400 w-4' : 'bg-white/50'}`;
                    dot.onclick = () => window.carousel.goTo(index);
                    dotsContainer.appendChild(dot);
                });

                // Touch swipe handlers
                let startX = 0;
                const container = document.getElementById('carousel-container');
                container.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
                container.addEventListener('touchend', (e) => {
                    const diffX = startX - e.changedTouches[0].clientX;
                    if (Math.abs(diffX) > 40) {
                        if (diffX > 0) window.carousel.next();
                        else window.carousel.prev();
                    }
                }, { passive: true });

                window.carousel.startAuto();
            },

            goTo: (index) => {
                const slides = document.querySelectorAll('.carousel-slide');
                const dots = document.getElementById('carousel-dots')?.children;
                if (!slides.length) return;

                slides[currentCarouselIndex].classList.remove('opacity-100', 'z-10');
                slides[currentCarouselIndex].classList.add('opacity-0', 'z-0');
                if (dots && dots[currentCarouselIndex]) {
                    dots[currentCarouselIndex].className = 'w-2 h-2 rounded-full bg-white/50 transition-all';
                }

                currentCarouselIndex = index;

                slides[currentCarouselIndex].classList.remove('opacity-0', 'z-0');
                slides[currentCarouselIndex].classList.add('opacity-100', 'z-10');
                if (dots && dots[currentCarouselIndex]) {
                    dots[currentCarouselIndex].className = 'w-2 h-2 rounded-full bg-amber-400 w-4 transition-all';
                }

                document.getElementById('carousel-tag').textContent = carouselData[index].tag;
                document.getElementById('carousel-title').textContent = carouselData[index].title;
            },

            next: () => {
                const nextIndex = (currentCarouselIndex + 1) % carouselData.length;
                window.carousel.goTo(nextIndex);
            },

            prev: () => {
                const prevIndex = (currentCarouselIndex - 1 + carouselData.length) % carouselData.length;
                window.carousel.goTo(prevIndex);
            },

            startAuto: () => {
                if (carouselInterval) clearInterval(carouselInterval);
                carouselInterval = setInterval(() => window.carousel.next(), 4500);
            }
        };

        function openMapUrl(url) {
            if (isIOS()) {
                const coordinates = getMapCoordinates(url);
                if (coordinates) {
                    window.location.href = getAppleMapsUrl(coordinates.lat, coordinates.lng);
                    return;
                }
            }
            window.open(url, '_blank', 'noopener');
        }

        function getEventLocationName(event) {
            return isNumericLocationName(event?.locationName)
                ? 'Ubicación seleccionada'
                : event?.locationName || 'Ubicación a confirmar';
        }

        function getEventTypeLabel(type) {
            const emojis = {
                Corporativo: '💼',
                Boda: '💍',
                Cumpleaños: '🎈',
                Retiro: '🌿',
                Privado: '🏠',
                Otro: '🎉'
            };
            const eventType = type || 'Evento';
            return `${emojis[eventType] || '🎉'} ${eventType}`;
        }

        async function hydrateLocationNames(events) {
            const pending = events.filter(event => isNumericLocationName(event.locationName) && event.locationUrl);
            await Promise.all(pending.map(async event => {
                const coordinates = getMapCoordinates(event.locationUrl);
                if (!coordinates) return;
                try {
                            const result = await geocode({ location: coordinates });
                            const name = getLocationName({ display_name: result.results?.[0]?.formatted_address });
                    if (name) event.locationName = name;
                } catch (error) {}
            }));
            localStorage.setItem('catering_events_v2', JSON.stringify(events));
            window.ui.renderPublicEvents();
            if (window.state.isAdmin) window.ui.renderAdminList();
        }

        window.ui = {
            showTab: (tabName) => {
                if (tabName === 'admin' && !window.state.isAdmin) {
                    window.app.requestAdminAccess();
                    return;
                }

                window.state.activeTab = tabName;
                document.getElementById('view-events').classList.toggle('hidden', tabName !== 'events');
                document.getElementById('view-admin').classList.toggle('hidden', tabName !== 'admin');

                const navEvents = document.getElementById('nav-events-btn');
                const navAdmin = document.getElementById('nav-admin-btn');

                if (tabName === 'events') {
                    navEvents.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 text-white border border-slate-700 transition-all';
                    if (navAdmin) navAdmin.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-all';
                } else {
                    navEvents.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-all';
                    if (navAdmin) navAdmin.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 text-white border border-slate-700 transition-all';
                }

                if (tabName === 'events') window.ui.renderPublicEvents();
                if (tabName === 'admin') window.ui.renderAdminList();
            },

            renderPublicEvents: () => {
                const grid = document.getElementById('public-events-grid');
                const empty = document.getElementById('public-empty-state');
                const badge = document.getElementById('events-count-badge');
                if (!grid) return;

                // Only show active (non-expired) events to public
                const activeEvents = window.state.events.filter(e => !isEventExpired(e));
                badge.textContent = activeEvents.length;

                if (activeEvents.length === 0) {
                    grid.innerHTML = '';
                    empty.classList.remove('hidden');
                    return;
                }

                empty.classList.add('hidden');
                grid.innerHTML = activeEvents.map(evt => {
                    const dateText = formatEventDateLabel(evt.days);
                    const locationName = getEventLocationName(evt);

                    // Each meal owns its checkbox so attendance can be selected independently.
                    return `
                        <div class="min-w-0 bg-white rounded-2xl p-5 shadow-sm border border-slate-200 hover:shadow-md transition-shadow flex flex-col justify-between space-y-4">
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full border border-slate-200">
                                        ${getEventTypeLabel(evt.type)}
                                    </span>
                                </div>

                                <!-- Highlighted Title Box -->
                                <div class="bg-slate-800 text-white p-3 rounded-xl shadow-inner border border-slate-700 mb-3 text-center">
                                    <h3 class="text-xl font-extrabold tracking-tight break-words">${evt.title}</h3>
                                </div>

                                <div class="space-y-1.5 text-xs text-slate-600">
                                    <div class="flex items-center gap-2">
                                        <i class="fa-regular fa-calendar text-slate-500 w-4 text-center"></i>
                                        <span class="font-medium text-slate-700">${dateText}</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <i class="fa-solid fa-location-dot text-rose-500 w-4 text-center"></i>
                                        <span class="font-medium text-slate-700 truncate">${locationName}</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Soft Green Menu Button -->
                            <button onclick="window.ui.openDetailsModal('${evt.id}')" class="w-full bg-emerald-100 text-emerald-900 hover:bg-emerald-200 active:bg-emerald-300 font-bold text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors border border-emerald-300/60 shadow-sm mt-2">
                                <i class="fa-solid fa-book-open text-emerald-700"></i> Ver Menú
                            </button>
                        </div>
                    `;
                }).join('');
            },

            renderAdminList: () => {
                const list = document.getElementById('admin-events-list');
                if (!list) return;

                let items = [...window.state.events];

                // Search Filter
                if (window.state.adminSearch) {
                    const q = window.state.adminSearch.toLowerCase();
                    items = items.filter(e => e.title.toLowerCase().includes(q) || (e.locationName && e.locationName.toLowerCase().includes(q)));
                }

                // Type Filter
                if (window.state.adminFilterType !== 'ALL') {
                    items = items.filter(e => e.type === window.state.adminFilterType);
                }

                // Sort
                items.sort((a, b) => {
                    if (window.state.adminSortOrder === 'ALPHA_ASC') return a.title.localeCompare(b.title);
                    if (window.state.adminSortOrder === 'ALPHA_DESC') return b.title.localeCompare(a.title);
                    if (window.state.adminSortOrder === 'OLDEST') return (a.createdAt || 0) - (b.createdAt || 0);
                    return (b.createdAt || 0) - (a.createdAt || 0); // RECENT
                });

                if (items.length === 0) {
                    list.innerHTML = `<div class="text-center py-8 text-xs text-slate-500 bg-white rounded-2xl border border-slate-200">No hay eventos registrados</div>`;
                    return;
                }

                list.innerHTML = items.map(evt => {
                    const expired = isEventExpired(evt);
                    const dateText = formatEventDateLabel(evt.days);

                    return `
                        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between gap-4">
                            <div class="min-w-0 overflow-hidden">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200">
                                        ${getEventTypeLabel(evt.type)}
                                    </span>
                                    ${expired ? `<span class="text-[9px] font-bold uppercase bg-rose-100 text-rose-700 px-2 py-0.5 rounded-md">Caducado</span>` : `<span class="text-[9px] font-bold uppercase bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-md">Activo</span>`}
                                </div>
                                <h4 class="font-bold text-base text-slate-900 truncate">${evt.title}</h4>
                                <p class="text-xs text-slate-500">${dateText}</p>
                            </div>
                            <div class="flex items-center gap-1.5 flex-shrink-0">
                                <button onclick="window.ui.editEvent('${evt.id}')" class="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center justify-center text-xs">
                                    <i class="fa-solid fa-pen"></i>
                                </button>
                                <button onclick="window.app.deleteEvent('${evt.id}')" class="w-8 h-8 rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 flex items-center justify-center text-xs">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');
            },

            openEventModal: (eventId = null) => {
                window.state.editingEventId = eventId;
                window.state.currentLocationName = '';
                const modal = document.getElementById('modal-event-form');
                const title = document.getElementById('event-form-title');
                const form = document.getElementById('event-form');
                form.reset();

                document.getElementById('form-event-id').value = '';
                document.getElementById('form-location-url').value = '';
                document.getElementById('location-status-text').textContent = 'Ninguna ubicación seleccionada';
                document.getElementById('contacts-container').innerHTML = '';

                if (eventId) {
                    const evt = window.state.events.find(e => e.id === eventId);
                    if (evt) {
                        title.textContent = 'Editar Evento';
                        document.getElementById('form-event-id').value = evt.id;
                        document.getElementById('form-title').value = evt.title;
                        document.getElementById('form-type').value = evt.type || 'Corporativo';
                        document.getElementById('form-days-count').value = (evt.days ? evt.days.length : 3).toString();
                        document.getElementById('form-location-name').value = isNumericLocationName(evt.locationName) ? '' : (evt.locationName || '');
                        document.getElementById('form-location-url').value = evt.locationUrl || '';
                        
                        if (evt.locationName || evt.locationUrl) {
                            document.getElementById('location-status-text').textContent = `Ubicación cargada: ${evt.locationName || 'Ver Mapa'}`;
                        }

                        window.ui.updateDaysBuilder(evt.days);
                        if (evt.contacts && evt.contacts.length) {
                            evt.contacts.forEach(c => window.ui.addContactRow(c.name, c.phone));
                        } else {
                            window.ui.addContactRow('Coordinador', '');
                        }
                    }
                } else {
                    title.textContent = 'Nuevo Evento';
                    window.ui.updateDaysBuilder();
                    window.ui.addContactRow('Coordinador', '');
                }

                modal.classList.remove('hidden');
            },

            closeEventModal: () => {
                document.getElementById('modal-event-form').classList.add('hidden');
            },

            updateDaysBuilder: (existingDays = null) => {
                const count = parseInt(document.getElementById('form-days-count').value, 10);
                const container = document.getElementById('days-container');
                container.innerHTML = '';

                for (let i = 0; i < count; i++) {
                    const dayData = existingDays && existingDays[i] ? existingDays[i] : { date: '', lunch: '', lunchTime: '12:00', lunchCost: '', dinner: '', dinnerTime: '21:30', dinnerCost: '' };
                    const dayDiv = document.createElement('div');
                    dayDiv.className = 'p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2';
                    dayDiv.innerHTML = `
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-slate-800 text-xs">Día ${i + 1}</span>
                            <div class="flex items-center gap-1">
                                <input type="date" id="day-date-${i}" aria-label="Fecha del día ${i + 1}" value="${dayData.date || ''}" class="bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-slate-800">
                            </div>
                        </div>
                        <div class="grid grid-cols-1 gap-2">
                            <div>
                                <div class="flex items-center justify-between mb-0.5">
                                    <label class="text-[16px] font-semibold text-slate-600">☀️ Almuerzo (opcional)</label>
                                    <div class="flex items-center gap-1">
                                        <span class="text-[14px] text-slate-500 font-medium">Hora:</span>
                                        <input type="time" id="day-lunch-time-${i}" value="${dayData.lunchTime || '12:00'}" class="bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                        <input type="text" id="day-lunch-cost-${i}" value="${dayData.lunchCost || ''}" inputmode="numeric" pattern="[0-9]*" placeholder="Costo" aria-label="Costo del almuerzo" class="day-cost-input w-20 bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                    </div>
                                </div>
                                <select id="day-lunch-menu-${i}" class="w-full bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                                    <option value="">Seleccionar imagen o PDF del menú</option>
                                    <option value="./img/menu.png">menu.png</option>
                                    <option value="./img/menu.pdf">menu.pdf</option>
                                </select>
                                <input type="file" id="day-lunch-file-${i}" accept="image/*,.pdf,application/pdf" class="w-full mt-1 text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white">
                                <p id="day-lunch-file-name-${i}" class="text-[10px] text-slate-500 truncate"></p>
                                <textarea id="day-lunch-detail-${i}" rows="2" placeholder="Detalle del menú de almuerzo (opcional)" class="w-full mt-1 bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800 resize-none">${dayData.lunchDetail || ''}</textarea>
                            </div>
                            <div>
                                <div class="flex items-center justify-between mb-0.5">
                                    <label class="text-[16px] font-semibold text-slate-600">🌙 Cena (opcional)</label>
                                    <div class="flex items-center gap-1">
                                        <span class="text-[14px] text-slate-500 font-medium">Hora:</span>
                                        <input type="time" id="day-dinner-time-${i}" value="${dayData.dinnerTime || '21:30'}" class="bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[11px] text-slate-800 focus:outline-none focus:border-slate-800">
                                        <input type="text" id="day-dinner-cost-${i}" value="${dayData.dinnerCost || ''}" inputmode="numeric" pattern="[0-9]*" placeholder="Costo" aria-label="Costo de la cena" class="day-cost-input w-20 bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[11px] text-slate-800 focus:outline-none focus:border-slate-800">
                                    </div>
                                </div>
                                <select id="day-dinner-menu-${i}" class="w-full bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                                    <option value="">Seleccionar imagen o PDF del menú</option>
                                    <option value="./img/menu.png">menu.png</option>
                                    <option value="./img/menu.pdf">menu.pdf</option>
                                </select>
                                <input type="file" id="day-dinner-file-${i}" accept="image/*,.pdf,application/pdf" class="w-full mt-1 text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white">
                                <p id="day-dinner-file-name-${i}" class="text-[10px] text-slate-500 truncate"></p>
                                <textarea id="day-dinner-detail-${i}" rows="2" placeholder="Detalle del menú de cena (opcional)" class="w-full mt-1 bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800 resize-none">${dayData.dinnerDetail || ''}</textarea>
                            </div>
                        </div>
                    `;
                    container.appendChild(dayDiv);
                    ['lunch', 'dinner'].forEach((meal) => {
                        const menu = dayData[`${meal}Menu`];
                        const select = dayDiv.querySelector(`#day-${meal}-menu-${i}`);
                        const fileInput = dayDiv.querySelector(`#day-${meal}-file-${i}`);
                        const fileName = dayDiv.querySelector(`#day-${meal}-file-name-${i}`);
                        if (menu?.src && !menu.src.startsWith('data:')) select.value = menu.src;
                        if (menu?.name) fileName.textContent = `Archivo actual: ${menu.name}`;
                        fileInput.addEventListener('change', () => {
                            fileName.textContent = fileInput.files[0]?.name || '';
                            if (fileInput.files[0]) select.value = '';
                        });
                    });
                    dayDiv.querySelectorAll('.day-cost-input').forEach((input) => {
                        input.addEventListener('input', (event) => {
                            event.target.value = event.target.value.replace(/\D/g, '');
                        });
                    });
                }
            },

            addContactRow: (name = '', phone = '') => {
                const container = document.getElementById('contacts-container');
                const div = document.createElement('div');
                div.className = 'contact-row flex items-center gap-2';
                div.innerHTML = `
                    <input type="text" value="${name}" placeholder="Nombre / Rol (Ej. Recepción)" class="contact-name w-1/2 bg-slate-50 border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                    <input type="tel" value="${phone}" placeholder="WhatsApp (Ej. 54911...)" class="contact-phone w-1/2 bg-slate-50 border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                    <button type="button" onclick="this.parentElement.remove()" class="text-rose-500 p-1 hover:text-rose-700">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                `;
                container.appendChild(div);
                div.querySelector('.contact-phone').addEventListener('input', (event) => {
                    event.target.value = event.target.value.replace(/\D/g, '');
                });
            },

            openMapModal: () => {
                document.getElementById('modal-map').classList.remove('hidden');
                loadGoogleMaps().then((maps) => {
                    if (!window.state.mapInstance) {
                        window.state.mapInstance = new maps.Map(document.getElementById('map-canvas'), {
                            center: { lat: -34.6037, lng: -58.3816 },
                            zoom: 12,
                            mapTypeControl: false,
                            streetViewControl: false,
                            fullscreenControl: false
                        });
                        window.state.mapInstance.addListener('click', (event) => {
                            window.app.setMapMarker(event.latLng.lat(), event.latLng.lng());
                        });
                    }
                }).catch((error) => {
                    document.getElementById('map-selected-label').textContent = error.message;
                });
            },

            closeMapModal: () => {
                document.getElementById('modal-map').classList.add('hidden');
            },

            openDetailsModal: (eventId) => {
                const evt = window.state.events.find(e => e.id === eventId);
                if (!evt) return;

                document.getElementById('detail-type-badge').textContent = getEventTypeLabel(evt.type);
                document.getElementById('detail-title').textContent = evt.title;

                const locName = document.getElementById('detail-location-name');
                const locLink = document.getElementById('detail-location-link');
                locName.textContent = getEventLocationName(evt);

                if (evt.locationUrl) {
                    locLink.href = evt.locationUrl;
                    locLink.onclick = (event) => {
                        event.preventDefault();
                        openMapUrl(evt.locationUrl);
                    };
                    locLink.classList.remove('hidden');
                } else {
                    locLink.onclick = null;
                    locLink.classList.add('hidden');
                }

                // Render Days Menus
                const daysContainer = document.getElementById('detail-days-list');
                daysContainer.innerHTML = (evt.days || []).map((day, idx) => {
                    const lunchTimeLabel = day.lunchTime ? ` ${day.lunchTime}Hs` : '';
                    const dinnerTimeLabel = day.dinnerTime ? ` ${day.dinnerTime}Hs` : '';
                    const lunchPast = isMomentPast(day.date, day.lunchTime);
                    const dinnerPast = isMomentPast(day.date, day.dinnerTime);
                    return `
                    <div class="p-5 bg-slate-50 border border-slate-200 rounded-2xl space-y-4">
                        <div class="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
                            <span class="font-bold text-base text-slate-800">Día ${idx + 1}</span>
                        </div>
                        ${day.lunch || day.lunchMenu?.src ? `
                            <div class="text-sm ${lunchPast ? 'opacity-40' : ''}">
                                <label class="flex items-center gap-3 font-extrabold text-amber-700 mb-1 ${lunchPast ? 'line-through cursor-not-allowed' : ''}"><input type="checkbox" class="confirmation-option h-5 w-5 shrink-0" data-day="${idx + 1}" data-meal="Almuerzo" ${lunchPast ? 'disabled' : ''}><span>☀️ Almuerzo${lunchTimeLabel}${day.lunchCost ? ` - ${formatCurrency(day.lunchCost)}` : ''}${lunchPast ? ' (finalizado)' : ''}</span></label>
                                ${renderMenuContent(day.lunchMenu, day.lunch, 'Almuerzo', day.lunchDetail || '')}
                            </div>
                        ` : ''}
                        ${day.dinner || day.dinnerMenu?.src ? `
                            <div class="border-t border-slate-200 pt-3 text-sm ${dinnerPast ? 'opacity-40' : ''}">
                                <label class="flex items-center gap-3 font-extrabold text-indigo-700 mb-1 ${dinnerPast ? 'line-through cursor-not-allowed' : ''}"><input type="checkbox" class="confirmation-option h-5 w-5 shrink-0" data-day="${idx + 1}" data-meal="Cena" ${dinnerPast ? 'disabled' : ''}><span>🌙 Cena${dinnerTimeLabel}${day.dinnerCost ? ` - ${formatCurrency(day.dinnerCost)}` : ''}${dinnerPast ? ' (finalizado)' : ''}</span></label>
                                ${renderMenuContent(day.dinnerMenu, day.dinner, 'Cena', day.dinnerDetail || '')}
                            </div>
                        ` : ''}
                        ${!day.lunch && !day.lunchMenu?.src && !day.dinner && !day.dinnerMenu?.src ? `<p class="text-[11px] text-slate-400 italic">Menú por definir</p>` : ''}
                    </div>
                `}).join('');

                // Render WhatsApp Confirmation Buttons
                const waContainer = document.getElementById('detail-whatsapp-buttons');
                    const contacts = evt.contacts && evt.contacts.length ? evt.contacts : [{ name: 'Administración', phone: adminWhatsAppPhone }];

                // Rebuild the WhatsApp links whenever a meal selection changes.
                const renderWhatsAppButtons = () => {
                    const selectedOptions = [...document.querySelectorAll('.confirmation-option:checked')]
                        .map(option => `Día ${option.dataset.day} - ${option.dataset.meal}`);
                    const attendance = selectedOptions.length ? selectedOptions.join(', ') : 'todos los momentos del evento';
                    waContainer.innerHTML = contacts.map(c => {
                    const cleanPhone = (c.phone || '').replace(/\D/g, '');
                    const message = encodeURIComponent(`Hola ${c.name || 'organizador'}, quiero confirmar mi asistencia al evento "${evt.title}" para: ${attendance}.`);
                    const waUrl = `https://wa.me/${cleanPhone}?text=${message}`;

                    return `
                        <a href="${waUrl}" target="_blank" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors shadow-sm">
                            <i class="fa-brands fa-whatsapp text-sm"></i> Confirmar con ${c.name || 'Contacto'}
                        </a>
                    `;
                    }).join('');
                };

                document.querySelectorAll('.confirmation-option').forEach(option => {
                    option.addEventListener('change', renderWhatsAppButtons);
                });
                renderWhatsAppButtons();

                document.getElementById('modal-event-details').classList.remove('hidden');
            },

            closeDetailsModal: () => {
                document.getElementById('modal-event-details').classList.add('hidden');
            },

            closeAdminAuthModal: () => {
                document.getElementById('modal-admin-auth').classList.add('hidden');
            },

            editEvent: (eventId) => {
                window.ui.openEventModal(eventId);
            },

            showAlert: (title, msg) => {
                document.getElementById('alert-title').textContent = title;
                document.getElementById('alert-message').textContent = msg;
                document.getElementById('modal-alert').classList.remove('hidden');
            },

            closeAlert: () => {
                document.getElementById('modal-alert').classList.add('hidden');
            }
        };

        window.app = {
            init: async () => {
                window.carousel.init();

                const adminTrigger = document.getElementById('admin-access-trigger');
                if (adminTrigger) {
                    let pressTimer = null;
                    const cancelPress = () => {
                        if (pressTimer) clearTimeout(pressTimer);
                        pressTimer = null;
                    };
                    adminTrigger.addEventListener('pointerdown', (event) => {
                        if (event.pointerType === 'mouse') return;
                        pressTimer = setTimeout(() => {
                            pressTimer = null;
                            window.app.requestAdminAccess();
                        }, 650);
                    });
                    adminTrigger.addEventListener('touchstart', () => {
                        pressTimer = setTimeout(() => {
                            pressTimer = null;
                            window.app.requestAdminAccess();
                        }, 650);
                    }, { passive: true });
                    adminTrigger.addEventListener('pointerup', cancelPress);
                    adminTrigger.addEventListener('pointercancel', cancelPress);
                    adminTrigger.addEventListener('pointerleave', cancelPress);
                    adminTrigger.addEventListener('touchend', cancelPress, { passive: true });
                    adminTrigger.addEventListener('touchcancel', cancelPress, { passive: true });
                    adminTrigger.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            window.app.requestAdminAccess();
                        }
                    });
                }

                // Load initial cached events
                const localData = localStorage.getItem('catering_events_v2');
                if (localData) {
                    try { window.state.events = JSON.parse(localData); } catch (e) {}
                }

                window.ui.renderPublicEvents();
                hydrateLocationNames(window.state.events);

                // Initialize Firebase Firestore Sync
                try {
                    if (firebaseConfig.apiKey && firebaseConfig.appId) {
                        const firebaseApp = initializeApp(firebaseConfig);
                        const auth = getAuth(firebaseApp);
                        const db = getFirestore(firebaseApp);
                        storage = getStorage(firebaseApp);
                        eventsCollection = collection(db, ...firebaseCollectionPath);
                        onSnapshot(eventsCollection, (snapshot) => {
                            const remoteEvents = [];
                            snapshot.forEach(docSnap => {
                                remoteEvents.push({ id: docSnap.id, ...docSnap.data() });
                            });

                            window.state.events = remoteEvents;
                            localStorage.setItem('catering_events_v2', JSON.stringify(remoteEvents));
                            window.ui.renderPublicEvents();
                            if (window.state.isAdmin) window.ui.renderAdminList();
                            hydrateLocationNames(remoteEvents);
                        }, (error) => {
                            console.warn('Firestore fallback to local:', error);
                        });
                        authReadyPromise = signInAnonymously(auth).catch((error) => {
                            console.warn('Anonymous auth unavailable; read-only mode:', error);
                            return null;
                        });
                    } else {
                        console.info('Firestore no configurado: se usará almacenamiento local.');
                    }
                } catch (e) {
                    console.warn('Database initialization warning:', e);
                }
            },

            handleHeaderTap: () => {
                window.state.headerTapCount++;
                if (window.state.headerTapTimer) clearTimeout(window.state.headerTapTimer);

                if (window.state.headerTapCount >= 3) {
                    window.state.headerTapCount = 0;
                    window.app.requestAdminAccess();
                } else {
                    window.state.headerTapTimer = setTimeout(() => {
                        window.state.headerTapCount = 0;
                    }, 1200);
                }
            },

            requestAdminAccess: () => {
                if (window.state.isAdmin) {
                    window.ui.showTab('admin');
                } else {
                    document.getElementById('admin-pin-input').value = '';
                    document.getElementById('modal-admin-auth').classList.remove('hidden');
                }
            },

            verifyAdminPin: () => {
                const input = document.getElementById('admin-pin-input').value;
                if (input === window.state.adminPIN) {
                    window.state.isAdmin = true;
                    document.getElementById('modal-admin-auth').classList.add('hidden');
                    document.getElementById('admin-logout-btn').classList.remove('hidden');
                    window.ui.showTab('admin');
                } else {
                    window.ui.showAlert('Error', 'PIN de administrador incorrecto.');
                }
            },

            logoutAdmin: () => {
                window.state.isAdmin = false;
                document.getElementById('admin-logout-btn').classList.add('hidden');
                window.ui.showTab('events');
            },

            saveEvent: async (e) => {
                e.preventDefault();
                const id = document.getElementById('form-event-id').value || 'evt_' + Date.now();
                const title = document.getElementById('form-title').value.trim();
                if (!title) {
                    window.ui.showAlert('Datos incompletos', 'Ingrese el nombre del evento.');
                    return;
                }
                const saveButton = e.submitter || document.querySelector('#event-form button[type="submit"]');
                const originalButtonText = saveButton?.textContent;
                if (saveButton) {
                    saveButton.disabled = true;
                    saveButton.textContent = 'Guardando...';
                }
                const type = document.getElementById('form-type').value;
                const daysCount = parseInt(document.getElementById('form-days-count').value, 10);
                let locationName = document.getElementById('form-location-name').value.trim();
                if (isNumericLocationName(locationName)) {
                    locationName = window.state.currentLocationName || 'Ubicación seleccionada';
                }
                const locationUrl = document.getElementById('form-location-url').value;
                const existingEvent = window.state.events.find(event => event.id === id);

                let days = [];
                try {
                    // Process all days/meals concurrently instead of one await at a time.
                    const dayPromises = [];
                    for (let i = 0; i < daysCount; i++) {
                        const existingDay = existingEvent?.days?.[i] || {};
                        const readMenu = async (meal) => {
                            const fileInput = document.getElementById(`day-${meal}-file-${i}`);
                            const selectedPath = document.getElementById(`day-${meal}-menu-${i}`)?.value;
                            if (fileInput?.files?.[0]) return uploadMenuFile(fileInput.files[0], id, i, meal);
                            if (selectedPath) {
                                return {
                                    name: selectedPath.split('/').pop(),
                                    type: selectedPath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*',
                                    src: selectedPath
                                };
                            }
                            return migrateLegacyMenu(existingDay[`${meal}Menu`], id, i, meal);
                        };
                        dayPromises.push(
                            Promise.all([readMenu('lunch'), readMenu('dinner')]).then(([lunchMenu, dinnerMenu]) => ({
                                date: document.getElementById(`day-date-${i}`)?.value || '',
                                lunch: lunchMenu ? '' : (existingDay.lunch || ''),
                                lunchMenu,
                                lunchDetail: document.getElementById(`day-lunch-detail-${i}`)?.value.trim() || '',
                                lunchTime: document.getElementById(`day-lunch-time-${i}`)?.value || '',
                                lunchCost: document.getElementById(`day-lunch-cost-${i}`)?.value || '',
                                dinner: dinnerMenu ? '' : (existingDay.dinner || ''),
                                dinnerMenu,
                                dinnerDetail: document.getElementById(`day-dinner-detail-${i}`)?.value.trim() || '',
                                dinnerTime: document.getElementById(`day-dinner-time-${i}`)?.value || '',
                                dinnerCost: document.getElementById(`day-dinner-cost-${i}`)?.value || ''
                            }))
                        );
                    }
                    days = await Promise.all(dayPromises);
                } catch (error) {
                    if (saveButton) {
                        saveButton.disabled = false;
                        saveButton.textContent = originalButtonText;
                    }
                    window.ui.showAlert('No se pudo cargar el menú', 'Verifique su conexión, el formato del archivo y que pese menos de 10 MB. El evento no fue guardado.');
                    return;
                }

                const contactRows = document.querySelectorAll('.contact-row');
                const contacts = [];
                contactRows.forEach(row => {
                    const name = row.querySelector('.contact-name')?.value;
                    const phone = row.querySelector('.contact-phone')?.value;
                    if (name || phone) contacts.push({ name, phone });
                });

                const newEvent = {
                    id,
                    title,
                    type,
                    locationName,
                    locationUrl,
                    days,
                    contacts,
                    createdAt: Date.now()
                };

                const index = window.state.events.findIndex(ev => ev.id === id);
                if (index >= 0) window.state.events[index] = newEvent;
                else window.state.events.push(newEvent);

                localStorage.setItem('catering_events_v2', JSON.stringify(window.state.events));

                // Confirm immediately with the local save; Firestore sync continues in the background.
                window.ui.closeEventModal();
                window.ui.renderPublicEvents();
                if (window.state.isAdmin) window.ui.renderAdminList();
                if (saveButton) {
                    saveButton.disabled = false;
                    saveButton.textContent = originalButtonText;
                }
                window.ui.showAlert('Evento guardado', 'El evento se guardó correctamente en este dispositivo. Sincronizando con Firebase…');

                try {
                    if (eventsCollection) {
                        await setDoc(doc(eventsCollection, id), newEvent);
                    }
                } catch (e) {
                    console.warn('Firestore write warning:', e);
                    window.ui.showAlert('Sincronización pendiente', 'El evento quedó guardado en este dispositivo, pero no se pudo sincronizar con Firebase todavía.');
                }
            },

            deleteEvent: async (id) => {
                if (!confirm('¿Desea eliminar este evento?')) return;

                window.state.events = window.state.events.filter(e => e.id !== id);
                localStorage.setItem('catering_events_v2', JSON.stringify(window.state.events));

                try {
                    if (eventsCollection) await deleteDoc(doc(eventsCollection, id));
                } catch (e) {}

                window.ui.renderAdminList();
                window.ui.renderPublicEvents();
            },

            setMapMarker: (lat, lng, label = '') => {
                window.state.currentMapCoords = { lat, lng };
                window.state.currentLocationName = label && !isNumericLocationName(label) ? label.trim() : '';
                if (window.state.mapMarker) {
                    window.state.mapMarker.setPosition({ lat, lng });
                } else {
                    window.state.mapMarker = new google.maps.Marker({
                        map: window.state.mapInstance,
                        position: { lat, lng }
                    });
                }
                window.state.mapInstance.panTo({ lat, lng });

                document.getElementById('map-selected-label').textContent = label || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`;

                geocode({ location: { lat, lng } })
                    .then(result => {
                        const name = result.results?.[0]?.formatted_address;
                        if (name) {
                            document.getElementById('map-selected-label').textContent = name;
                            window.state.currentLocationName = name;
                        }
                    }).catch(() => {});
            },

            searchMapLocation: () => {
                const query = document.getElementById('map-search-input').value;
                if (!query) return;

                geocode({ address: query })
                    .then(result => {
                        const first = result.results?.[0];
                        if (first) {
                            const location = first.geometry.location;
                            const lat = location.lat();
                            const lng = location.lng();
                            window.app.setMapMarker(lat, lng, first.formatted_address);
                            window.state.mapInstance.setZoom(16);
                        } else {
                            window.ui.showAlert('Mapa', 'No se encontraron resultados para la búsqueda.');
                        }
                    }).catch(error => window.ui.showAlert('Google Maps', error.message));
            },

            useDeviceGPS: () => {
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            window.app.setMapMarker(pos.coords.latitude, pos.coords.longitude, 'Mi Ubicación GPS');
                        },
                        () => {
                            window.ui.showAlert('GPS', 'No se pudo obtener la ubicación de tu dispositivo.');
                        }
                    );
                }
            },

            confirmMapSelection: () => {
                if (!window.state.currentMapCoords) {
                    window.ui.showAlert('Mapa', 'Por favor selecciona un punto en el mapa.');
                    return;
                }

                const { lat, lng } = window.state.currentMapCoords;
                const url = getGoogleMapsUrl(lat, lng);
                const nameInput = document.getElementById('form-location-name');

                if (window.state.currentLocationName) {
                    nameInput.value = window.state.currentLocationName;
                }

                document.getElementById('form-location-url').value = url;
                document.getElementById('location-status-text').textContent = `Ubicación configurada (${isIOS() ? 'Apple Maps' : 'Google Maps'})`;
                window.ui.closeMapModal();
            },

            openSelectedLocation: () => {
                if (!window.state.currentMapCoords) {
                    window.ui.showAlert('Mapa', 'Por favor selecciona un punto en el mapa.');
                    return;
                }
                const { lat, lng } = window.state.currentMapCoords;
                openMapUrl(getGoogleMapsUrl(lat, lng));
            },

            handleAdminSearch: (val) => {
                window.state.adminSearch = val;
                window.ui.renderAdminList();
            },

            handleAdminFilterType: (val) => {
                window.state.adminFilterType = val;
                window.ui.renderAdminList();
            },

            handleAdminSort: (val) => {
                window.state.adminSortOrder = val;
                window.ui.renderAdminList();
            }
        };

        // Initialize application on load
        window.addEventListener('DOMContentLoaded', () => {
            window.app.init();
        });

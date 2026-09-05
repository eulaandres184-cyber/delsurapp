        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
        import { firebaseConfig, firebaseCollectionPath } from './firebase-config.js';
        import {
            formatCurrency,
            formatEventDayLabel,
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

        async function uploadMenuFile(file, eventId, dayIndex, meal, imgIndex = 0) {
            if (!storage || !file) return null;
            await authReadyPromise;
            const extension = fileExtension(file.name, file.type);
            const storagePath = `menus/${eventId}/dia-${dayIndex + 1}-${meal}-${imgIndex}-${Date.now()}.${extension}`;
            const fileRef = ref(storage, storagePath);
            await uploadBytes(fileRef, file, { contentType: file.type || 'application/octet-stream' });
            return {
                name: file.name,
                type: file.type || 'application/octet-stream',
                src: await getDownloadURL(fileRef),
                storagePath
            };
        }

        async function migrateLegacyMenu(menu, eventId, dayIndex, meal, imgIndex = 0) {
            if (!menu?.src?.startsWith('data:')) return menu;
            const response = await fetch(menu.src);
            const blob = await response.blob();
            const file = new File([blob], menu.name || `menu-${meal}.${fileExtension(menu.name, menu.type)}`, { type: menu.type || blob.type });
            return uploadMenuFile(file, eventId, dayIndex, meal, imgIndex);
        }

        // Menu images can be stored either as a single legacy object or an array of images.
        function normalizeMenuArray(menu) {
            if (Array.isArray(menu)) return menu.map(item => ({ ...item }));
            return menu?.src ? [{ ...menu }] : [];
        }

        function hasMenuImages(menu) {
            return Array.isArray(menu) ? menu.length > 0 : Boolean(menu?.src);
        }

        function renderMenuContent(menu, fallbackText, label, detail = '') {
            const images = normalizeMenuArray(menu);
            const detailContent = detail.trim()
                ? `<p class="mt-2 text-sm text-slate-700 whitespace-pre-line bg-white p-3 rounded-xl border border-slate-200/60">${detail}</p>`
                : '';
            if (!images.length) {
                return fallbackText
                    ? `<p class="text-slate-700 whitespace-pre-line bg-white p-3 rounded-xl border border-slate-200/60">${fallbackText}</p>${detailContent}`
                    : `${detailContent || `<p class="text-[11px] text-slate-400 italic">${label} por definir</p>`}`;
            }

            const renderSlide = (item) => (item.type === 'application/pdf' || item.src.toLowerCase().includes('.pdf'))
                ? `<div class="menu-slide w-full shrink-0"><iframe src="${item.src}" title="${label}" class="w-full h-80 rounded-xl border border-slate-200 bg-white"></iframe><a href="${item.src}" target="_blank" class="mt-1 inline-block text-[11px] font-semibold text-slate-600 underline">Abrir PDF</a></div>`
                : `<div class="menu-slide w-full shrink-0"><img src="${item.src}" alt="${label}" class="w-full max-h-[28rem] object-contain rounded-xl border border-slate-200 bg-white"></div>`;

            if (images.length === 1) {
                return `${renderSlide(images[0])}${detailContent}`;
            }

            const slidesHtml = images.map(renderSlide).join('');
            const dotsHtml = images.map((_, idx) => `<button type="button" class="menu-slider-dot w-1.5 h-1.5 rounded-full ${idx === 0 ? 'bg-slate-800' : 'bg-slate-300'} transition-colors" data-index="${idx}" aria-label="Imagen ${idx + 1}"></button>`).join('');

            return `
                <div class="menu-slider relative">
                    <div class="menu-slider-viewport overflow-hidden rounded-xl border border-slate-200 bg-white">
                        <div class="menu-slider-track flex touch-pan-y">${slidesHtml}</div>
                    </div>
                    <button type="button" class="menu-slider-prev absolute left-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 border border-slate-200 shadow flex items-center justify-center text-slate-700 hover:bg-white" aria-label="Imagen anterior"><i class="fa-solid fa-chevron-left"></i></button>
                    <button type="button" class="menu-slider-next absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 border border-slate-200 shadow flex items-center justify-center text-slate-700 hover:bg-white" aria-label="Imagen siguiente"><i class="fa-solid fa-chevron-right"></i></button>
                    <div class="menu-slider-dots flex justify-center gap-1.5 mt-2">${dotsHtml}</div>
                </div>
                ${detailContent}
            `;
        }

        // Turns a slider's slides into a seamless infinite loop, swipeable in both directions.
        function initMenuSlider(slider) {
            const track = slider.querySelector('.menu-slider-track');
            const originalSlides = [...track.children];
            const count = originalSlides.length;
            if (!track || count < 2) return;

            track.appendChild(originalSlides[0].cloneNode(true));
            track.insertBefore(originalSlides[count - 1].cloneNode(true), track.firstChild);

            let index = 1;
            const dots = [...slider.querySelectorAll('.menu-slider-dot')];

            const setTransform = (animate = true) => {
                track.style.transition = animate ? 'transform 0.4s ease' : 'none';
                track.style.transform = `translateX(-${index * 100}%)`;
            };
            const updateDots = () => {
                const realIndex = (index - 1 + count) % count;
                dots.forEach((dot, i) => dot.classList.toggle('bg-slate-800', i === realIndex));
                dots.forEach((dot, i) => dot.classList.toggle('bg-slate-300', i !== realIndex));
            };

            setTransform(false);
            updateDots();

            const goNext = () => { index++; setTransform(); updateDots(); };
            const goPrev = () => { index--; setTransform(); updateDots(); };

            track.addEventListener('transitionend', () => {
                if (index === count + 1) { index = 1; setTransform(false); }
                else if (index === 0) { index = count; setTransform(false); }
            });

            slider.querySelector('.menu-slider-next')?.addEventListener('click', goNext);
            slider.querySelector('.menu-slider-prev')?.addEventListener('click', goPrev);
            dots.forEach((dot, i) => dot.addEventListener('click', () => { index = i + 1; setTransform(); updateDots(); }));

            let startX = null;
            track.addEventListener('touchstart', (event) => { startX = event.touches[0].clientX; }, { passive: true });
            track.addEventListener('touchend', (event) => {
                if (startX === null) return;
                const diff = event.changedTouches[0].clientX - startX;
                if (Math.abs(diff) > 40) (diff < 0 ? goNext() : goPrev());
                startX = null;
            }, { passive: true });
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

        function getGeocodingError(status) {
            if (status === 'REQUEST_DENIED') {
                return 'Google Maps no autoriza Geocoding API para esta clave. Revise las restricciones de API y la facturación en Google Cloud.';
            }
            if (status === 'ZERO_RESULTS') return 'Google Maps no encontró esa ubicación.';
            if (status === 'OVER_QUERY_LIMIT') return 'Se alcanzó el límite de consultas de Google Maps.';
            return `Google Maps no pudo resolver la ubicación (${status || 'error desconocido'}).`;
        }

        async function geocode(request) {
            await loadGoogleMaps();
            const response = await new google.maps.Geocoder().geocode(request);
            if (response.status !== 'OK') throw new Error(getGeocodingError(response.status));
            return response.results;
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
                            await loadGoogleMaps();
                            const result = await new google.maps.Geocoder().geocode({ location: coordinates });
                            const name = getLocationName({ display_name: result.results?.[0]?.formatted_address });
                    if (name) event.locationName = name;
                } catch (error) {
                    console.warn('No se pudo actualizar el nombre del lugar:', error.message);
                }
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
                    const daysHtml = (evt.days || []).map((day, idx) => {
                        const dayDateLabel = formatEventDayLabel(day.date);
                        const hasLunch = day.lunchEnabled ?? (Boolean(day.lunch) || hasMenuImages(day.lunchMenu));
                        const hasDinner = day.dinnerEnabled ?? (Boolean(day.dinner) || hasMenuImages(day.dinnerMenu));
                        const lunchTimeLabel = day.lunchTime ? ` ${day.lunchTime}Hs` : '';
                        const dinnerTimeLabel = day.dinnerTime ? ` ${day.dinnerTime}Hs` : '';
                        const lunchPast = isMomentPast(day.date, day.lunchTime);
                        const dinnerPast = isMomentPast(day.date, day.dinnerTime);
                        return `
                        <div class="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
                            <div class="flex items-center justify-between gap-3 border-b border-slate-200 pb-2">
                                <div class="w-full bg-white text-slate-800 p-3 rounded-xl shadow-inner border border-slate-200 text-center">
                                    <h5 class="text-xl font-extrabold tracking-tight break-words">${dayDateLabel}</h5>
                                </div>
                            </div>
                            ${hasLunch ? `
                                <div class="text-sm ${lunchPast ? 'opacity-40' : ''}">
                                    <label class="flex items-center gap-3 font-extrabold text-amber-700 mb-1 ${lunchPast ? 'line-through cursor-not-allowed' : ''}"><input type="checkbox" class="confirmation-option h-5 w-5 shrink-0" data-day="${idx + 1}" data-meal="Almuerzo" ${lunchPast ? 'disabled' : ''}><span>☀️ Almuerzo${lunchTimeLabel}${day.lunchCost ? ` - ${formatCurrency(day.lunchCost)}` : ''}${lunchPast ? ' (finalizado)' : ''}</span></label>
                                    ${renderMenuContent(day.lunchMenu, day.lunch, 'Almuerzo', day.lunchDetail || '')}
                                </div>
                            ` : ''}
                            ${hasDinner ? `
                                <div class="border-t border-slate-200 pt-3 text-sm ${dinnerPast ? 'opacity-40' : ''}">
                                    <label class="flex items-center gap-3 font-extrabold text-indigo-700 mb-1 ${dinnerPast ? 'line-through cursor-not-allowed' : ''}"><input type="checkbox" class="confirmation-option h-5 w-5 shrink-0" data-day="${idx + 1}" data-meal="Cena" ${dinnerPast ? 'disabled' : ''}><span>🌙 Cena${dinnerTimeLabel}${day.dinnerCost ? ` - ${formatCurrency(day.dinnerCost)}` : ''}${dinnerPast ? ' (finalizado)' : ''}</span></label>
                                    ${renderMenuContent(day.dinnerMenu, day.dinner, 'Cena', day.dinnerDetail || '')}
                                </div>
                            ` : ''}
                            ${!hasLunch && !hasDinner ? `<p class="text-sm text-slate-400 italic">Menú por definir</p>` : ''}
                        </div>
                    `;
                    }).join('');

                    return `
                        <div class="min-w-0 bg-white rounded-2xl p-5 shadow-sm border border-slate-200 hover:shadow-md transition-shadow flex flex-col space-y-4" data-event-id="${evt.id}">
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    ${evt.type ? `<span class="text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full border border-slate-200">
                                        ${getEventTypeLabel(evt.type)}
                                    </span>` : ''}
                                </div>

                                <!-- Highlighted Title Box -->
                                <div class="bg-slate-800 text-white p-3 rounded-xl shadow-inner border border-slate-700 mb-3 text-center">
                                    <h3 class="text-xl font-extrabold tracking-tight break-words">${evt.title}</h3>
                                </div>
                            </div>

                            <!-- Menu content, previously behind "Ver Menú", now shown directly on the card -->
                            <div class="space-y-3">
                                <h4 class="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                                    <i class="fa-solid fa-utensils text-amber-500"></i> Propuesta Gastronómica
                                </h4>
                                <div class="event-days-list space-y-3">${daysHtml}</div>
                            </div>

                            ${evt.locationUrl ? `
                                <a href="${evt.locationUrl}" data-url="${evt.locationUrl}" target="_blank" rel="noopener" class="location-map-link flex items-center justify-center gap-2 text-sm font-semibold text-sky-700 hover:text-sky-800 hover:underline break-words">
                                    <i class="fa-solid fa-location-dot"></i> ${locationName}
                                </a>
                            ` : ''}

                            <div class="event-whatsapp-buttons space-y-3 pt-3 border-t border-slate-200"></div>
                        </div>
                    `;
                }).join('');

                grid.querySelectorAll('.menu-slider').forEach(initMenuSlider);

                // Wire the WhatsApp confirmation buttons per card, scoped to that event's checkboxes only.
                activeEvents.forEach(evt => {
                    const card = grid.querySelector(`[data-event-id="${evt.id}"]`);
                    if (!card) return;
                    const contacts = evt.contacts && evt.contacts.length ? evt.contacts : [{ name: 'Administración', phone: adminWhatsAppPhone }];
                    const waContainer = card.querySelector('.event-whatsapp-buttons');

                    const mapLink = card.querySelector('.location-map-link');
                    if (mapLink) {
                        mapLink.addEventListener('click', (event) => {
                            event.preventDefault();
                            openMapUrl(mapLink.dataset.url);
                        });
                    }

                    const renderWhatsAppButtons = () => {
                        const selectedOptions = [...card.querySelectorAll('.confirmation-option:checked')]
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

                    card.querySelectorAll('.confirmation-option').forEach(option => {
                        option.addEventListener('change', renderWhatsAppButtons);
                    });
                    renderWhatsAppButtons();
                });
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
                                    ${evt.type ? `<span class="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200">
                                        ${getEventTypeLabel(evt.type)}
                                    </span>` : ''}
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
                window.state.currentMapCoords = null;
                // Clear any marker left over from a previous event so it doesn't leak into this session.
                if (window.state.mapMarker) {
                    window.state.mapMarker.setMap(null);
                    window.state.mapMarker = null;
                }
                const mapLabel = document.getElementById('map-selected-label');
                if (mapLabel) mapLabel.textContent = 'Haga clic en el mapa para marcar';
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
                        document.getElementById('form-type').value = evt.type || '';
                        document.getElementById('form-location-name').value = isNumericLocationName(evt.locationName) ? '' : (evt.locationName || '');
                        document.getElementById('form-location-url').value = evt.locationUrl || '';

                        const existingCoords = getMapCoordinates(evt.locationUrl);
                        if (existingCoords) {
                            window.state.currentMapCoords = existingCoords;
                            window.state.currentLocationName = isNumericLocationName(evt.locationName) ? '' : (evt.locationName || '');
                        }
                        
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
                const container = document.getElementById('days-container');
                container.innerHTML = '';
                const days = existingDays?.length ? existingDays : [{}];
                days.forEach(day => window.ui.addDayBuilder(day));
            },

            addDayBuilder: (dayData = {}) => {
                const container = document.getElementById('days-container');
                const dayId = [...container.querySelectorAll('.event-day-builder')].reduce((highest, day) => Math.max(highest, Number(day.dataset.dayId)), -1) + 1;
                const hasLunch = dayData.lunchEnabled ?? (Boolean(dayData.lunch) || hasMenuImages(dayData.lunchMenu));
                const hasDinner = dayData.dinnerEnabled ?? (Boolean(dayData.dinner) || hasMenuImages(dayData.dinnerMenu));
                const dayDiv = document.createElement('div');
                dayDiv.dataset.dayId = dayId;
                dayDiv.className = 'event-day-builder p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2';
                dayDiv.innerHTML = `
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-slate-800 text-xs">Fecha del evento</span>
                            <div class="flex items-center gap-1">
                                <input type="date" aria-label="Fecha del evento" value="${dayData.date || ''}" class="day-date bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-slate-800">
                                <button type="button" onclick="window.ui.removeDayBuilder(this)" class="text-rose-500 p-1 hover:text-rose-700" aria-label="Eliminar día" title="Eliminar día"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 gap-2">
                            <div>
                                <div class="flex items-center justify-between mb-0.5">
                                    <label class="flex items-center gap-2 text-[16px] font-semibold text-slate-600"><input type="checkbox" class="day-lunch-enabled h-4 w-4" ${hasLunch ? 'checked' : ''} onchange="window.ui.updateMealVisibility(this)">☀️ Almuerzo</label>
                                    <div class="flex items-center gap-1">
                                        <span class="text-[14px] text-slate-500 font-medium">Hora:</span>
                                        <input type="time" value="${dayData.lunchTime || '12:00'}" class="day-lunch-time bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                        <input type="text" value="${dayData.lunchCost || ''}" inputmode="numeric" pattern="[0-9]*" placeholder="Costo" aria-label="Costo del almuerzo" class="day-lunch-cost day-cost-input w-20 bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                    </div>
                                </div>
                                <div class="day-lunch-details space-y-1">
                                <div class="day-lunch-images flex flex-wrap gap-2"></div>
                                <select class="day-lunch-preset w-full bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                                    <option value="">Agregar imagen predefinida...</option>
                                    <option value="./img/menu.png">menu.png</option>
                                    <option value="./img/menu.pdf">menu.pdf</option>
                                </select>
                                <input type="file" accept="image/*,.pdf,application/pdf" multiple class="day-lunch-file w-full mt-1 text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white">
                                <p class="text-[10px] text-slate-500">Puede seleccionar varias imágenes (Entrada, Plato principal, Postre, etc.)</p>
                                <textarea rows="2" placeholder="Detalle del menú de almuerzo (opcional)" class="day-lunch-detail auto-grow-textarea w-full mt-1 bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800 resize-none overflow-hidden">${dayData.lunchDetail || ''}</textarea></div>
                            </div>
                            <div>
                                <div class="flex items-center justify-between mb-0.5">
                                    <label class="flex items-center gap-2 text-[16px] font-semibold text-slate-600"><input type="checkbox" class="day-dinner-enabled h-4 w-4" ${hasDinner ? 'checked' : ''} onchange="window.ui.updateMealVisibility(this)">🌙 Cena</label>
                                    <div class="flex items-center gap-1">
                                        <span class="text-[14px] text-slate-500 font-medium">Hora:</span>
                                        <input type="time" value="${dayData.dinnerTime || '21:30'}" class="day-dinner-time bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                        <input type="text" value="${dayData.dinnerCost || ''}" inputmode="numeric" pattern="[0-9]*" placeholder="Costo" aria-label="Costo de la cena" class="day-dinner-cost day-cost-input w-20 bg-white border border-slate-300 rounded-md px-1 py-0.5 text-[14px] text-slate-800 focus:outline-none focus:border-slate-800">
                                    </div>
                                </div>
                                <div class="day-dinner-details space-y-1">
                                <div class="day-dinner-images flex flex-wrap gap-2"></div>
                                <select class="day-dinner-preset w-full bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800">
                                    <option value="">Agregar imagen predefinida...</option>
                                    <option value="./img/menu.png">menu.png</option>
                                    <option value="./img/menu.pdf">menu.pdf</option>
                                </select>
                                <input type="file" accept="image/*,.pdf,application/pdf" multiple class="day-dinner-file w-full mt-1 text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white">
                                <p class="text-[10px] text-slate-500">Puede seleccionar varias imágenes (Entrada, Plato principal, Postre, etc.)</p>
                                <textarea rows="2" placeholder="Detalle del menú de cena (opcional)" class="day-dinner-detail auto-grow-textarea w-full mt-1 bg-white border border-slate-300 rounded-xl p-2 text-xs focus:outline-none focus:border-slate-800 resize-none overflow-hidden">${dayData.dinnerDetail || ''}</textarea></div>
                            </div>
                        </div>
                    `;
                container.appendChild(dayDiv);
                dayDiv._images = {};
                ['lunch', 'dinner'].forEach((meal) => {
                    dayDiv._images[meal] = normalizeMenuArray(dayData[`${meal}Menu`]);
                    const chipsContainer = dayDiv.querySelector(`.day-${meal}-images`);
                    const fileInput = dayDiv.querySelector(`.day-${meal}-file`);
                    const presetSelect = dayDiv.querySelector(`.day-${meal}-preset`);

                    const renderChips = () => {
                        chipsContainer.innerHTML = dayDiv._images[meal].map((img, idx) => `
                            <span class="menu-image-chip inline-flex items-center gap-1 bg-white border border-slate-300 rounded-lg px-2 py-1 text-[10px] text-slate-700 max-w-[9rem]">
                                <i class="fa-solid ${img.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-image'} text-slate-400"></i>
                                <span class="truncate">${img.name || `Imagen ${idx + 1}`}</span>
                                <button type="button" data-idx="${idx}" class="menu-image-remove text-rose-500 hover:text-rose-700" aria-label="Quitar imagen"><i class="fa-solid fa-xmark"></i></button>
                            </span>
                        `).join('');
                        chipsContainer.querySelectorAll('.menu-image-remove').forEach((btn) => {
                            btn.addEventListener('click', () => {
                                dayDiv._images[meal].splice(Number(btn.dataset.idx), 1);
                                renderChips();
                            });
                        });
                    };
                    renderChips();

                    fileInput.addEventListener('change', () => {
                        [...fileInput.files].forEach((file) => {
                            dayDiv._images[meal].push({ file, name: file.name, type: file.type || 'application/octet-stream', src: URL.createObjectURL(file) });
                        });
                        fileInput.value = '';
                        renderChips();
                    });

                    presetSelect.addEventListener('change', () => {
                        if (!presetSelect.value) return;
                        dayDiv._images[meal].push({
                            name: presetSelect.value.split('/').pop(),
                            type: presetSelect.value.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*',
                            src: presetSelect.value
                        });
                        presetSelect.value = '';
                        renderChips();
                    });

                    window.ui.updateMealVisibility(dayDiv.querySelector(`.day-${meal}-enabled`));
                });
                dayDiv.querySelectorAll('.day-cost-input').forEach((input) => {
                    input.addEventListener('input', (event) => {
                        event.target.value = event.target.value.replace(/\D/g, '');
                    });
                });
                dayDiv.querySelectorAll('.auto-grow-textarea').forEach((textarea) => {
                    const resize = () => {
                        textarea.style.height = 'auto';
                        textarea.style.height = `${textarea.scrollHeight}px`;
                    };
                    textarea.addEventListener('input', resize);
                    resize();
                });
            },

            removeDayBuilder: (button) => {
                button.closest('.event-day-builder').remove();
                if (!document.querySelector('.event-day-builder')) window.ui.addDayBuilder();
            },

            updateMealVisibility: (checkbox) => {
                const meal = checkbox.classList.contains('day-lunch-enabled') ? 'lunch' : 'dinner';
                checkbox.closest('.event-day-builder').querySelector(`.day-${meal}-details`).classList.toggle('hidden', !checkbox.checked);
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
                    // Restore the marker for the event being edited instead of leaving it at the default center.
                    if (window.state.currentMapCoords && !window.state.mapMarker) {
                        window.app.setMapMarker(window.state.currentMapCoords.lat, window.state.currentMapCoords.lng, window.state.currentLocationName);
                        window.state.mapInstance.setZoom(16);
                    } else if (!window.state.currentMapCoords) {
                        window.state.mapInstance.setCenter({ lat: -34.6037, lng: -58.3816 });
                        window.state.mapInstance.setZoom(12);
                    }
                }).catch((error) => {
                    document.getElementById('map-selected-label').textContent = error.message;
                });
            },

            closeMapModal: () => {
                document.getElementById('modal-map').classList.add('hidden');
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
                const dayRows = [...document.querySelectorAll('.event-day-builder')];
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
                    for (const [i, dayRow] of dayRows.entries()) {
                        const existingDay = existingEvent?.days?.[i] || {};
                        const readMenu = async (meal, isEnabled) => {
                            if (!isEnabled) return [];
                            const images = dayRow._images?.[meal] || [];
                            const uploaded = await Promise.all(images.map((img, idx) => {
                                if (img.file) return uploadMenuFile(img.file, id, i, meal, idx);
                                return migrateLegacyMenu(img, id, i, meal, idx);
                            }));
                            return uploaded.filter(Boolean);
                        };
                        const lunchEnabled = dayRow.querySelector('.day-lunch-enabled').checked;
                        const dinnerEnabled = dayRow.querySelector('.day-dinner-enabled').checked;
                        dayPromises.push(
                            Promise.all([readMenu('lunch', lunchEnabled), readMenu('dinner', dinnerEnabled)]).then(([lunchMenu, dinnerMenu]) => ({
                                date: dayRow.querySelector('.day-date')?.value || '',
                                lunchEnabled,
                                lunch: lunchEnabled && !lunchMenu.length ? (existingDay.lunch || '') : '',
                                lunchMenu,
                                lunchDetail: lunchEnabled ? dayRow.querySelector('.day-lunch-detail')?.value.trim() || '' : '',
                                lunchTime: lunchEnabled ? dayRow.querySelector('.day-lunch-time')?.value || '' : '',
                                lunchCost: lunchEnabled ? dayRow.querySelector('.day-lunch-cost')?.value || '' : '',
                                dinnerEnabled,
                                dinner: dinnerEnabled && !dinnerMenu.length ? (existingDay.dinner || '') : '',
                                dinnerMenu,
                                dinnerDetail: dinnerEnabled ? dayRow.querySelector('.day-dinner-detail')?.value.trim() || '' : '',
                                dinnerTime: dinnerEnabled ? dayRow.querySelector('.day-dinner-time')?.value || '' : '',
                                dinnerCost: dinnerEnabled ? dayRow.querySelector('.day-dinner-cost')?.value || '' : ''
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
                        // Rules require an authenticated user; wait for anonymous sign-in to finish first.
                        await authReadyPromise;
                        // Firestore rejects `undefined` fields (e.g. days without an uploaded menu yet).
                        const firestoreEvent = JSON.parse(JSON.stringify(newEvent));
                        await setDoc(doc(eventsCollection, id), firestoreEvent);
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
                    if (eventsCollection) {
                        await authReadyPromise;
                        await deleteDoc(doc(eventsCollection, id));
                    }
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

                loadGoogleMaps().then(() => new google.maps.Geocoder().geocode({ location: { lat, lng } }))
                    .then(result => {
                        const name = result.results?.[0]?.formatted_address;
                        if (name) {
                            document.getElementById('map-selected-label').textContent = name;
                            window.state.currentLocationName = name;
                        }
                    }).catch(error => {
                        document.getElementById('map-selected-label').textContent = error.message;
                    });
            },

            searchMapLocation: () => {
                const query = document.getElementById('map-search-input').value;
                if (!query) return;

                loadGoogleMaps().then(() => new google.maps.Geocoder().geocode({ address: query }))
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

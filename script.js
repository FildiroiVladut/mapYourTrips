"use strict";

/* =========================================================================
   Map Your Trips
   Draw a route on the map, add how long it took, and the app works out
   distance, pace/speed and your totals. Trips are saved in localStorage.
   ========================================================================= */

const STORAGE_KEY = "mapYourTrips.v2";
const DEFAULT_VIEW = { center: [44.4368, 26.0905], zoom: 13 }; // Bucharest

const TYPES = {
  walk: { label: "Walk", metric: "pace" },
  run: { label: "Run", metric: "pace" },
  bike: { label: "Bike", metric: "speed" },
};

/* ---------- Formatting helpers ---------- */

const fmtKm = (km) => km.toFixed(2);

const fmtPace = (minPerKm) => {
  if (!Number.isFinite(minPerKm)) return "–";
  let min = Math.floor(minPerKm);
  let sec = Math.round((minPerKm - min) * 60);
  if (sec === 60) {
    min += 1;
    sec = 0;
  }
  return `${min}:${String(sec).padStart(2, "0")}`;
};

const fmtDuration = (totalMin) => {
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const fmtDate = (date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- Model ---------- */

class Trip {
  constructor({ id, type, name, route, duration, date, sample = false }) {
    this.id = id ?? crypto.randomUUID();
    this.type = type;
    this.name = name;
    this.route = route; // [[lat, lng], ...]
    this.duration = duration; // minutes
    this.date = date ? new Date(date) : new Date();
    this.sample = sample;
  }

  // Sum of the straight segments between the points you clicked, in km
  get distance() {
    let metres = 0;
    for (let i = 1; i < this.route.length; i++) {
      metres += L.latLng(this.route[i - 1]).distanceTo(this.route[i]);
    }
    return metres / 1000;
  }

  get pace() {
    return this.duration / this.distance; // min/km
  }

  get speed() {
    return this.distance / (this.duration / 60); // km/h
  }

  get metric() {
    return TYPES[this.type].metric === "pace"
      ? { value: fmtPace(this.pace), unit: "min/km" }
      : { value: this.speed.toFixed(1), unit: "km/h" };
  }

  toJSON() {
    const { id, type, name, route, duration, date, sample } = this;
    return { id, type, name, route, duration, date, sample };
  }
}

/* Example trips so a first visit isn't an empty map */
const daysAgo = (n, hour) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
};

const SAMPLE_TRIPS = [
  {
    type: "run",
    name: "Herăstrău lake loop",
    duration: 34,
    date: daysAgo(1, 7),
    route: [
      [44.4672, 26.079], [44.469, 26.076], [44.4722, 26.0735], [44.4755, 26.0745],
      [44.478, 26.0775], [44.479, 26.0815], [44.4778, 26.0858], [44.4752, 26.0895],
      [44.472, 26.0912], [44.469, 26.0895], [44.4668, 26.0858], [44.466, 26.082], [44.4672, 26.079],
    ],
  },
  {
    type: "walk",
    name: "Cișmigiu to Old Town",
    duration: 32,
    date: daysAgo(3, 18),
    route: [
      [44.4362, 26.087], [44.4378, 26.0868], [44.439, 26.0885], [44.4388, 26.0915],
      [44.4372, 26.0935], [44.4365, 26.0965], [44.4352, 26.099], [44.4335, 26.1005], [44.4318, 26.1012],
    ],
  },
  {
    type: "bike",
    name: "Along the Dâmbovița",
    duration: 24,
    date: daysAgo(6, 10),
    route: [
      [44.4335, 26.048], [44.4322, 26.056], [44.4318, 26.065], [44.431, 26.074], [44.4302, 26.083],
      [44.43, 26.092], [44.429, 26.101], [44.427, 26.11], [44.4258, 26.119], [44.425, 26.128],
    ],
  },
].map((t) => ({ ...t, sample: true }));

/* ---------- DOM ---------- */

const $ = (sel) => document.querySelector(sel);

const el = {
  map: $("#map"),
  hint: $("#hint"),
  trips: $("#trips"),
  empty: $("#empty"),
  sampleBanner: $("#sample-banner"),
  clearSamples: $("#clear-samples"),
  filters: document.querySelectorAll(".filter"),
  statDistance: $("#stat-distance"),
  statTrips: $("#stat-trips"),
  statTime: $("#stat-time"),
  panel: $("#panel"),
  panelDraw: $("#panel-draw"),
  panelForm: $("#panel-form"),
  liveKm: $("#live-km"),
  livePoints: $("#live-points"),
  btnUndo: $("#btn-undo"),
  btnCancel: $("#btn-cancel"),
  btnDone: $("#btn-done"),
  btnBack: $("#btn-back"),
  inputName: $("#input-name"),
  inputDuration: $("#input-duration"),
  formSummary: $("#form-summary"),
  formError: $("#form-error"),
};

/* ---------- App ---------- */

class App {
  #map;
  #trips = [];
  #layers = new Map(); // trip id -> { line, start }
  #mode = "idle"; // idle | drawing | saving
  #draft = null; // { points: LatLng[], line, markers: [] }
  #filter = "all";
  #activeId = null;
  #geocodeController = null;

  constructor() {
    this.#load();
    this.#initMap();
    this.#bindEvents();
    this.#render();
    this.#fitToTrips() || this.#locateUser({ silent: true });
  }

  /* ----- Setup ----- */

  #initMap() {
    this.#map = L.map(el.map, { zoomControl: false }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    L.control.zoom({ position: "topright" }).addTo(this.#map);
    this.#addLocateControl();

    // Standard OpenStreetMap tiles; the dark look is a CSS filter on the tile pane
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.#map);

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => this.#restyleRoutes());

    this.#map.on("click", (e) => this.#handleMapClick(e.latlng));
    this.#trips.forEach((t) => this.#drawTrip(t));
  }

  #addLocateControl() {
    const Locate = L.Control.extend({
      options: { position: "topright" },
      onAdd: () => {
        const div = L.DomUtil.create("div", "leaflet-bar");
        const a = L.DomUtil.create("a", "locate-btn", div);
        a.href = "#";
        a.title = "Go to my location";
        a.setAttribute("role", "button");
        a.innerHTML = "◎";
        L.DomEvent.on(a, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          this.#locateUser({ silent: false });
        });
        return div;
      },
    });
    this.#map.addControl(new Locate());
  }

  #locateUser({ silent }) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => this.#map.flyTo([coords.latitude, coords.longitude], 15, { duration: 0.8 }),
      () => {
        if (!silent) this.#flashHint("Location is blocked. You can still draw anywhere on the map.");
      },
      { timeout: 8000 }
    );
  }

  #bindEvents() {
    el.btnUndo.addEventListener("click", () => this.#undoPoint());
    el.btnCancel.addEventListener("click", () => this.#cancelDrawing());
    el.btnDone.addEventListener("click", () => this.#finishDrawing());
    el.btnBack.addEventListener("click", () => this.#setMode("drawing"));
    el.panelForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.#saveTrip();
    });
    el.panelForm.addEventListener("input", () => this.#updateFormSummary());

    document.addEventListener("keydown", (e) => {
      const typing = e.target.matches("input, textarea");
      if (this.#mode === "drawing") {
        if (e.key === "Enter") this.#finishDrawing();
        if (e.key === "Escape") this.#cancelDrawing();
        if ((e.key === "z" && (e.ctrlKey || e.metaKey)) || (e.key === "Backspace" && !typing)) {
          e.preventDefault();
          this.#undoPoint();
        }
      } else if (this.#mode === "saving" && e.key === "Escape") {
        this.#cancelDrawing();
      }
    });

    el.trips.addEventListener("click", (e) => this.#handleListClick(e));
    el.trips.addEventListener("mouseover", (e) => this.#highlight(e.target.closest(".trip")?.dataset.id));
    el.trips.addEventListener("mouseleave", () => this.#highlight(null));

    el.filters.forEach((btn) =>
      btn.addEventListener("click", () => {
        this.#filter = btn.dataset.filter;
        el.filters.forEach((b) => b.classList.toggle("is-active", b === btn));
        this.#render();
        this.#trips.forEach((t) => this.#setTripVisible(t));
      })
    );

    el.clearSamples.addEventListener("click", () => {
      this.#trips.filter((t) => t.sample).forEach((t) => this.#removeTripLayers(t.id));
      this.#trips = this.#trips.filter((t) => !t.sample);
      this.#persist();
      this.#render();
    });
  }

  /* ----- Drawing a route ----- */

  #handleMapClick(latlng) {
    if (this.#mode === "idle") {
      this.#startDrawing();
    }
    if (this.#mode === "drawing") this.#addPoint(latlng);
  }

  #startDrawing() {
    this.#selectTrip(null);
    this.#draft = {
      points: [],
      markers: [],
      line: L.polyline([], { color: cssVar("--brand"), weight: 4, dashArray: "8 8" }).addTo(this.#map),
    };
    this.#setMode("drawing");
  }

  #addPoint(latlng) {
    const d = this.#draft;
    d.points.push(latlng);
    d.line.setLatLngs(d.points);
    const isFirst = d.points.length === 1;
    d.markers.push(
      L.circleMarker(latlng, {
        radius: isFirst ? 7 : 5,
        color: cssVar("--brand"),
        fillColor: isFirst ? cssVar("--brand") : cssVar("--surface"),
        fillOpacity: 1,
        weight: 2,
        className: "route-point",
        interactive: false,
      }).addTo(this.#map)
    );
    this.#updateLive();
  }

  #undoPoint() {
    const d = this.#draft;
    if (!d) return;
    d.points.pop();
    d.markers.pop()?.remove();
    d.line.setLatLngs(d.points);
    if (d.points.length === 0) return this.#cancelDrawing();
    this.#updateLive();
  }

  #updateLive() {
    const km = new Trip({ route: this.#draft.points.map((p) => [p.lat, p.lng]) }).distance;
    const n = this.#draft.points.length;
    el.liveKm.textContent = fmtKm(km);
    el.livePoints.textContent = `${n} point${n === 1 ? "" : "s"}`;
    el.btnDone.disabled = n < 2;
  }

  #cancelDrawing() {
    if (this.#draft) {
      this.#draft.line.remove();
      this.#draft.markers.forEach((m) => m.remove());
    }
    this.#draft = null;
    this.#geocodeController?.abort();
    this.#setMode("idle");
  }

  #finishDrawing() {
    if (!this.#draft || this.#draft.points.length < 2) return;
    this.#setMode("saving");
    el.formError.hidden = true;
    el.inputDuration.value = "";
    el.inputName.value = "";
    el.inputName.placeholder = "Finding the place…";
    this.#updateFormSummary();
    el.inputDuration.focus();
    this.#suggestName(this.#draft.points[0]);
  }

  // Ask OpenStreetMap what's at the start of the route, e.g. "Parcul Herăstrău"
  async #suggestName({ lat, lng }) {
    this.#geocodeController?.abort();
    this.#geocodeController = new AbortController();
    const fallback = `${this.#selectedType().label} on ${fmtDate(new Date())}`;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, {
        signal: this.#geocodeController.signal,
        headers: { "Accept-Language": navigator.language || "en" },
      });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const a = data.address ?? {};
      const place = a.park || a.leisure || data.name || a.road || a.neighbourhood || a.suburb || a.city;
      if (!el.inputName.value) el.inputName.value = place ? place : fallback;
    } catch (err) {
      if (err.name === "AbortError") return;
      if (!el.inputName.value) el.inputName.value = fallback;
    } finally {
      el.inputName.placeholder = "Name this trip";
    }
  }

  #selectedType() {
    const type = el.panelForm.querySelector('input[name="type"]:checked').value;
    return { key: type, ...TYPES[type] };
  }

  #updateFormSummary() {
    if (!this.#draft) return;
    const trip = new Trip({
      type: this.#selectedType().key,
      route: this.#draft.points.map((p) => [p.lat, p.lng]),
      duration: +el.inputDuration.value,
    });
    const km = `<b>${fmtKm(trip.distance)} km</b>`;
    el.formSummary.innerHTML =
      trip.duration > 0 ? `${km} · <b>${trip.metric.value}</b> ${trip.metric.unit}` : `${km} · add a duration to see your ${TYPES[trip.type].metric}`;
  }

  #saveTrip() {
    const duration = +el.inputDuration.value;
    if (!Number.isFinite(duration) || duration <= 0) {
      el.formError.textContent = "Add how many minutes the trip took.";
      el.formError.hidden = false;
      el.inputDuration.focus();
      return;
    }
    const type = this.#selectedType();
    const trip = new Trip({
      type: type.key,
      name: el.inputName.value.trim() || `${type.label} on ${fmtDate(new Date())}`,
      route: this.#draft.points.map((p) => [p.lat, p.lng]),
      duration,
    });

    this.#cancelDrawing();
    this.#trips.push(trip);
    this.#persist();
    this.#drawTrip(trip);
    if (this.#filter !== "all" && this.#filter !== trip.type) {
      this.#filter = "all";
      el.filters.forEach((b) => b.classList.toggle("is-active", b.dataset.filter === "all"));
      this.#trips.forEach((t) => this.#setTripVisible(t));
    }
    this.#render();
    this.#selectTrip(trip.id);
  }

  #setMode(mode) {
    this.#mode = mode;
    el.panel.hidden = mode === "idle";
    el.panelDraw.hidden = mode !== "drawing";
    el.panelForm.hidden = mode !== "saving";
    el.hint.hidden = mode !== "idle";
    el.map.classList.toggle("is-drawing", mode === "drawing");
    if (mode === "drawing") this.#updateLive();
  }

  #flashHint(text) {
    const original = el.hint.lastChild.textContent;
    el.hint.lastChild.textContent = ` ${text}`;
    setTimeout(() => (el.hint.lastChild.textContent = original), 4000);
  }

  /* ----- Saved trips on the map ----- */

  #drawTrip(trip) {
    const color = cssVar(`--${trip.type}`);
    const line = L.polyline(trip.route, { color, weight: 5, opacity: 0.85, lineCap: "round", lineJoin: "round" });
    const start = L.circleMarker(trip.route[0], { radius: 6, color, weight: 3, fillColor: cssVar("--surface"), fillOpacity: 1 });
    const popup = () => `
      <div class="popup__name">${escapeHtml(trip.name)}</div>
      ${TYPES[trip.type].label} · ${fmtDate(trip.date)}<br />
      <b>${fmtKm(trip.distance)} km</b> · ${fmtDuration(trip.duration)} · ${trip.metric.value} ${trip.metric.unit}`;
    line.bindPopup(popup);
    start.bindPopup(popup);
    [line, start].forEach((layer) =>
      layer.on("click", (e) => {
        L.DomEvent.stopPropagation(e); // don't start a new route
        if (this.#mode === "idle") this.#selectTrip(trip.id, { fly: false });
      })
    );
    this.#layers.set(trip.id, { line, start });
    this.#setTripVisible(trip);
  }

  #setTripVisible(trip) {
    const layers = this.#layers.get(trip.id);
    if (!layers) return;
    const show = this.#filter === "all" || this.#filter === trip.type;
    for (const layer of [layers.line, layers.start]) {
      if (show) layer.addTo(this.#map);
      else layer.remove();
    }
  }

  #removeTripLayers(id) {
    const layers = this.#layers.get(id);
    if (!layers) return;
    layers.line.remove();
    layers.start.remove();
    this.#layers.delete(id);
  }

  #restyleRoutes() {
    for (const trip of this.#trips) {
      const layers = this.#layers.get(trip.id);
      const color = cssVar(`--${trip.type}`);
      layers?.line.setStyle({ color });
      layers?.start.setStyle({ color, fillColor: cssVar("--surface") });
    }
  }

  #highlight(id) {
    for (const [tripId, { line }] of this.#layers) {
      const on = tripId === id || tripId === this.#activeId;
      line.setStyle({ weight: on ? 8 : 5, opacity: id && !on ? 0.35 : 0.85 });
      if (on) line.bringToFront();
    }
  }

  #selectTrip(id, { fly = true } = {}) {
    this.#activeId = id;
    el.trips.querySelectorAll(".trip").forEach((li) => li.classList.toggle("is-active", li.dataset.id === id));
    this.#highlight(id);
    if (!id) return this.#map.closePopup();
    const { line } = this.#layers.get(id);
    if (fly) this.#map.flyToBounds(line.getBounds(), { padding: [60, 60], duration: 0.8, maxZoom: 16 });
    line.openPopup(line.getCenter());
    el.trips.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  #fitToTrips() {
    if (this.#trips.length === 0) return false;
    const bounds = L.latLngBounds(this.#trips.flatMap((t) => t.route));
    this.#map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    return true;
  }

  /* ----- Sidebar ----- */

  #handleListClick(e) {
    const li = e.target.closest(".trip");
    if (!li) return;
    const id = li.dataset.id;

    if (e.target.closest(".trip__delete")) {
      li.querySelector(".trip__confirm").hidden = false;
      return;
    }
    if (e.target.closest("[data-action='keep']")) {
      li.querySelector(".trip__confirm").hidden = true;
      return;
    }
    if (e.target.closest("[data-action='delete']")) {
      this.#removeTripLayers(id);
      this.#trips = this.#trips.filter((t) => t.id !== id);
      if (this.#activeId === id) this.#selectTrip(null);
      this.#persist();
      this.#render();
      return;
    }
    if (this.#mode !== "idle") return;
    this.#selectTrip(id);
  }

  #render() {
    const visible = this.#trips
      .filter((t) => this.#filter === "all" || t.type === this.#filter)
      .sort((a, b) => b.date - a.date);

    el.trips.innerHTML = visible.map((t) => this.#tripHtml(t)).join("");
    el.empty.hidden = this.#trips.length > 0;
    el.sampleBanner.hidden = !this.#trips.some((t) => t.sample);

    const totalKm = this.#trips.reduce((sum, t) => sum + t.distance, 0);
    const totalMin = this.#trips.reduce((sum, t) => sum + t.duration, 0);
    el.statDistance.textContent = totalKm >= 100 ? Math.round(totalKm) : totalKm.toFixed(1);
    el.statTrips.textContent = this.#trips.length;
    el.statTime.textContent = fmtDuration(totalMin);

    if (this.#activeId) {
      el.trips.querySelector(`[data-id="${this.#activeId}"]`)?.classList.add("is-active");
    }
  }

  #tripHtml(t) {
    const { value, unit } = t.metric;
    return `
      <li class="trip trip--${t.type}" data-id="${t.id}">
        <div>
          <div class="trip__top">
            <span class="trip__name">${escapeHtml(t.name)}</span>
          </div>
          <div class="trip__meta"><span class="trip__type">${TYPES[t.type].label}</span> · ${fmtDate(t.date)}</div>
        </div>
        <button class="trip__delete" aria-label="Delete ${escapeHtml(t.name)}" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        </button>
        <div class="trip__numbers">
          <div class="trip__num"><b>${fmtKm(t.distance)}</b><span>km</span></div>
          <div class="trip__num"><b>${fmtDuration(t.duration)}</b><span>time</span></div>
          <div class="trip__num"><b>${value}</b><span>${unit}</span></div>
        </div>
        <div class="trip__confirm" hidden>
          <span>Delete this trip?</span>
          <button class="btn btn--danger" data-action="delete">Delete</button>
          <button class="btn btn--ghost" data-action="keep">Keep</button>
        </div>
      </li>`;
  }

  /* ----- Storage ----- */

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#trips));
    } catch {
      /* storage full or blocked: the app keeps working for this visit */
    }
  }

  #load() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      data = null;
    }
    // First visit: show example trips so the map isn't empty
    this.#trips = (Array.isArray(data) ? data : SAMPLE_TRIPS).map((t) => new Trip(t));
  }
}

new App();

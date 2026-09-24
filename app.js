/* =========================================================================
   ROAD TRIP MAROC — application (vanilla JS + MapLibre GL)
   Aucune dépendance externe au moment de l'exécution : MapLibre est embarqué.
   ========================================================================= */
(function () {
"use strict";

/* ---------- Petits utilitaires ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); }

/* ---------- Stockage local ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const KEY_STATUS = "rtm_status_v1";   // { placeId: "fav"|"want"|"done"|"skip" }
const KEY_ADDED = "rtm_added_v1";      // [ place, ... ]
const KEY_PREFS = "rtm_prefs_v1";      // { basemap, day, ... }

let statuses = LS.get(KEY_STATUS, {});
let added = LS.get(KEY_ADDED, []);
let prefs = LS.get(KEY_PREFS, {});

/* ---------- État global ---------- */
let DATA = null;              // données du voyage
let PLACES = [];              // tous les lieux (data + ajoutés)
let byId = {};                // index id -> lieu
let map = null;
let currentDay = "all";       // "all" | 1..10
let filters = {
  cats: null,                 // Set des catégories actives (null = toutes)
  minInterest: 0,
  detour: "all",              // all | sur_la_route | petit_detour | detour_interessant
  status: "all",              // all | verifie | a_reconfirmer | incertain
  favOnly: false,
  selOnly: false,             // ⭐ sélection de lieux par nuit
  around: null,               // {lat,lon,km}
  maxVisitMin: null,          // "Que faire maintenant ?"
  query: "",                  // recherche par nom
};
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
let userPos = null;           // {lat,lon}
let geoCtrl = null;           // contrôle de géolocalisation MapLibre
let pendingPos = null;        // callback en attente de position
let addMode = false;
let popup = null;
const KEY_ROUTES = "rtm_routes_geo_v3";  // v2 : recalcul des tracés après changement des jours 2/3/4
let routeGeoCache = LS.get(KEY_ROUTES, {});  // { dayNum: [[lon,lat],…] } vraies routes
let ROUTE_WAYPOINTS = {};                    // points d'origine (corridors) par jour

/* ---------- Chargement des données ---------- */
async function loadData() {
  // 1) tentative fetch (fonctionne via le lanceur / en ligne)
  try {
    const r = await fetch("data/roadtrip.json", { cache: "no-cache" });
    if (r.ok) return await r.json();
  } catch (e) { /* file:// -> on bascule */ }
  // 2) repli : script global (ouverture directe du fichier)
  if (window.ROADTRIP_DATA) return window.ROADTRIP_DATA;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "data/roadtrip.js"; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.ROADTRIP_DATA;
}

/* ---------- Analyse durées / détours ---------- */
function durationToMin(str) {
  if (!str) return null;
  let s = String(str).toLowerCase();
  // prend la borne haute
  const parts = s.split(/[–-]/);
  const chunk = parts[parts.length - 1];
  let h = 0, m = 0;
  let mh = chunk.match(/(\d+)\s*h(?:\s*(\d+))?/);
  if (mh) { h = parseInt(mh[1]); if (mh[2]) m = parseInt(mh[2]); return h * 60 + m; }
  let mm = chunk.match(/(\d+)\s*min/);
  if (mm) return parseInt(mm[1]);
  // "demi-journée" etc.
  if (s.includes("journée")) return 300;
  return null;
}
function detourMaxMin(place) {
  const d = (place.detour || "").toLowerCase();
  if (place.detourClass === "sur_la_route") return 5;
  const m = d.match(/(\d+)\s*[–-]\s*(\d+)\s*min/);
  if (m) return parseInt(m[2]);
  if (d.includes("sur la route") || d.includes("sur place") || d.includes("étape")) return 5;
  return null;
}

/* ---------- Icônes emoji (rendues sur canvas, robustes) ---------- */
function makeEmojiIcon(emoji, ring) {
  const pr = 2, size = 48, c = document.createElement("canvas");
  c.width = c.height = size * pr; const g = c.getContext("2d"); g.scale(pr, pr);
  const cx = size / 2, cy = size / 2 - 4, r = 16;
  // ombre portée douce
  g.beginPath(); g.ellipse(cx, size - 5, 8.5, 3, 0, 0, 7); g.fillStyle = "rgba(60,40,20,.22)"; g.fill();
  // pointe
  g.beginPath();
  g.moveTo(cx, size - 3);
  g.quadraticCurveTo(cx - r * 0.62, cy + r * 0.72, cx - r * 0.42, cy + r * 0.42);
  g.lineTo(cx + r * 0.42, cy + r * 0.42);
  g.quadraticCurveTo(cx + r * 0.62, cy + r * 0.72, cx, size - 3);
  g.closePath();
  g.fillStyle = ring || "#C1440E"; g.fill();
  // disque
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill();
  g.lineWidth = 3; g.strokeStyle = ring || "#C1440E"; g.stroke();
  // emoji
  g.font = "20px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(emoji, cx, cy + 1);
  const data = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: data.data, pixelRatio: pr };
}

const CAT_COLORS = {
  restaurant: "#C1440E", cafe: "#B5651D", hebergement: "#8E5572", patrimoine: "#9E3608",
  medina: "#2E8B8B", souk: "#D4A017", artisanat: "#B5651D", kasbah: "#A0522D",
  randonnee: "#6E8B3D", promenade: "#6E8B3D", panorama: "#3E7CB1", photo: "#3E7CB1",
  desert: "#D99A2B", oasis: "#2E8B57", gorge: "#2E8B8B", nature: "#4C7A34",
  activite: "#7048E8", escalade: "#7048E8", musique: "#7048E8", bonus: "#B5651D",
  station: "#6C6459", parking: "#6C6459", vigilance: "#E23E57", aventure: "#D2691E",
  distributeur: "#2F6F4E",
};

function makeClusterIcon() {
  const pr = 2, size = 28, c = document.createElement("canvas");
  c.width = c.height = size * pr; const g = c.getContext("2d"); g.scale(pr, pr);
  g.strokeStyle = "#fff"; g.lineWidth = 3; g.lineCap = "round";
  const cx = size / 2, a = 6;
  g.beginPath(); g.moveTo(cx - a, cx); g.lineTo(cx + a, cx); g.moveTo(cx, cx - a); g.lineTo(cx, cx + a); g.stroke();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data, pixelRatio: pr };
}

/* ---------- Styles de fond de carte ---------- */
function baseStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        ],
        tileSize: 256, maxzoom: 20, attribution: "© OpenStreetMap, © CARTO",
      },
      topo: { type: "raster", tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png", "https://c.tile.opentopomap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 17, attribution: "© OpenTopoMap (CC-BY-SA)" },
      esri: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Imagerie © Esri" },
      esriRef: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "© Esri" },
      esriTrans: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "© Esri" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e9e4da" } },
      { id: "b-osm", type: "raster", source: "osm", layout: { visibility: "visible" } },
      { id: "b-topo", type: "raster", source: "topo", layout: { visibility: "none" } },
      { id: "b-esri", type: "raster", source: "esri", layout: { visibility: "none" } },
      { id: "b-esriTrans", type: "raster", source: "esriTrans", layout: { visibility: "none" } },
      { id: "b-esriRef", type: "raster", source: "esriRef", layout: { visibility: "none" } },
    ],
  };
}
function setBasemap(mode) {
  const vis = { "b-osm": "none", "b-topo": "none", "b-esri": "none", "b-esriRef": "none", "b-esriTrans": "none" };
  if (mode === "plan") vis["b-osm"] = "visible";
  else if (mode === "relief") vis["b-topo"] = "visible";
  else if (mode === "sat") vis["b-esri"] = "visible";
  else if (mode === "satinfo") { vis["b-esri"] = "visible"; vis["b-esriTrans"] = "visible"; vis["b-esriRef"] = "visible"; }
  Object.entries(vis).forEach(([id, v]) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); });
  $$("#basemapSwitch button").forEach(b => b.classList.toggle("active", b.dataset.base === mode));
  prefs.basemap = mode; LS.set(KEY_PREFS, prefs);
}

/* ---------- Construction des features ---------- */
function placeFeature(p) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    properties: { id: p.id, emoji: p.emoji || "📍", cat: p.category, name: p.name, icon: iconIdFor(p) },
  };
}
function iconIdFor(p) {
  const st = statuses[p.id];
  if (st === "fav") return "ic_fav";
  if (st === "done") return "ic_done";
  return "ic_" + (p.category || "bonus");
}

/* ---------- Filtrage ---------- */
function placeMatches(p) {
  if (p.hidden) return false;
  if (p.lat == null || p.lon == null) return false;
  if (filters.query) {
    const hay = norm(p.name + " " + (p.region || "") + " " + (p.categoryLabel || ""));
    if (!hay.includes(filters.query)) return false;
  }
  if (currentDay !== "all") {
    const d = Number(currentDay);
    if (!(p.days && p.days.includes(d))) return false;
  }
  // en vue "Tous", l'Option B est aussi affichée (comme l'itinéraire d'origine)
  if (filters.cats && !filters.cats.has(p.category)) return false;
  if (filters.minInterest && !(p.interest >= filters.minInterest)) return false;
  if (filters.detour !== "all") {
    if (p.detourClass !== filters.detour) {
      // détour_interessant inclut aussi les grands ; sinon strict
      if (!(filters.detour === "detour_interessant" && p.detourClass == null && (detourMaxMin(p) || 999) > 15)) return false;
    }
  }
  if (filters.status !== "all" && p.status !== filters.status) return false;
  if (filters.favOnly) { const s = statuses[p.id]; if (s !== "fav" && s !== "want") return false; }
  if (filters.selOnly && !p.selection) return false;
  if (filters.maxVisitMin != null) {
    const v = durationToMin(p.duree); if (v != null && v > filters.maxVisitMin) return false;
    const dm = detourMaxMin(p); if (dm != null && dm > 20) return false;
  }
  if (filters.around) {
    const dist = haversine(filters.around.lat, filters.around.lon, p.lat, p.lon);
    if (dist > filters.around.km) return false;
  }
  return true;
}
function visiblePlaces() { return PLACES.filter(placeMatches); }

function haversine(la1, lo1, la2, lo2) {
  const R = 6371, toR = Math.PI / 180;
  const dLa = (la2 - la1) * toR, dLo = (lo2 - lo1) * toR;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * toR) * Math.cos(la2 * toR) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- Rafraîchissement carte + listes ---------- */
function refresh() {
  const vis = visiblePlaces();
  const fc = { type: "FeatureCollection", features: vis.map(placeFeature) };
  const src = map.getSource("places"); if (src) src.setData(fc);
  // routes : filtre par jour
  const rf = DATA.routes.features.filter(f => currentDay === "all" ? true : f.properties.day === Number(currentDay));
  const rsrc = map.getSource("routes"); if (rsrc) rsrc.setData({ type: "FeatureCollection", features: rf });
  renderList(vis);
  renderTimeline();
  updateFilterBadge();
  $("#listCount").textContent = "(" + vis.length + ")";
}

/* ---------- En-tête d'une journée ---------- */
function renderDaySummary() {
  const box = $("#daySummary");
  if (currentDay === "all") { box.hidden = true; return; }
  const d = DATA.days.find(x => x.num === Number(currentDay));
  if (!d) { box.hidden = true; return; }
  const dayPlaces = PLACES.filter(p => p.days && p.days.includes(d.num));
  const byCat = (c) => dayPlaces.filter(p => p.category === c).length;
  const vig = dayPlaces.filter(p => p.category === "vigilance");
  box.hidden = false;
  box.style.borderLeftColor = d.color;
  box.innerHTML =
    `<h3>${d.optionB ? esc(d.label) : "Jour " + d.num + " — " + esc(d.label)}</h3>
     <div class="grid">
       <div>🗓️ ${esc(d.date)}</div><div>🌙 Nuit : ${esc(d.night)}</div>
       <div>🚗 ${esc(String(d.km))} km</div><div>⏱️ ${esc(d.drive)}</div>
       <div>🍴 ${byCat("restaurant")} restaurants</div><div>🥾 ${byCat("randonnee")} randonnées</div>
       <div>🏛️ ${byCat("patrimoine") + byCat("kasbah")} patrimoine</div><div>🌄 ${byCat("panorama") + byCat("gorge")} panoramas</div>
     </div>
     ${vig.length ? `<div class="vig">⚠️ Vigilance : ${vig.map(v => esc(v.name)).join(" · ")}</div>` : ""}`;
}

/* ---------- Liste des lieux ---------- */
function placeItem(p) {
  const it = el("div", "place-item");
  it.dataset.id = p.id;
  const st = statuses[p.id];
  const favIcon = st === "fav" ? "❤️" : st === "want" ? "✅" : st === "done" ? "✔️" : st === "skip" ? "❌" : "🤍";
  const stars = p.interest ? `<span class="stars">${"★".repeat(p.interest)}${"☆".repeat(5 - p.interest)}</span>` : "";
  const dayTags = (p.days && p.days.length) ? `<span class="chip">${p.days.map(x => x >= 100 ? ("J" + (x - 100) + "ᴮ") : ("J" + x)).join(" ")}</span>` : "";
  const extTag = p.exterior ? `<span class="chip warn">👁️ extérieur</span>` : "";
  const detourTag = p.detourClass === "sur_la_route" ? `<span class="chip">Sur la route</span>` :
    p.detourClass === "petit_detour" ? `<span class="chip">Petit détour</span>` :
      p.detourClass === "detour_interessant" ? `<span class="chip">Détour</span>` : "";
  const warn = p.status === "incertain" ? `<span class="chip warn">⚠️</span>` : "";
  const zone = p.coordPrecision === "zone" ? `<span class="chip">≈ secteur</span>` : (p.coordPrecision == null ? `<span class="chip warn">position à compléter</span>` : "");
  const selTag = p.selection ? `<span class="chip sel">⭐ Sélection</span>` : "";
  it.innerHTML =
    `<div class="pi-emoji">${p.emoji || "📍"}</div>
     <div class="pi-main">
       <div class="pi-name">${p.selection ? "⭐ " : ""}${esc(p.name)}</div>
       <div class="pi-meta">${stars} ${selTag} ${dayTags} ${detourTag} ${warn} ${extTag} ${zone}
         <span class="chip">${esc(p.categoryLabel || "")}</span></div>
     </div>
     <button class="pi-fav" title="Statut">${favIcon}</button>`;
  it.addEventListener("click", (e) => { if (e.target.classList.contains("pi-fav")) return; openCard(p.id, true); });
  it.querySelector(".pi-fav").addEventListener("click", (e) => { e.stopPropagation(); cycleStatus(p.id); });
  return it;
}
function renderList(vis) {
  const box = $("#placeList"); box.innerHTML = "";
  if (!vis.length) { box.appendChild(el("div", "empty", "Aucun lieu ne correspond. Ajustez les filtres ou la journée.")); return; }
  // tri : intérêt desc puis nom — tous les lieux affichés
  vis.slice().sort((a, b) => (b.interest || 0) - (a.interest || 0) || a.name.localeCompare(b.name))
    .forEach(p => box.appendChild(placeItem(p)));
  renderFav();
}
function renderFav() {
  const box = $("#favList"); box.innerHTML = "";
  const mine = PLACES.filter(p => statuses[p.id]);
  if (!mine.length) { box.appendChild(el("div", "empty", "Marquez des lieux avec ❤️ Favori, ✅ à faire, ✔️ visité. Ils apparaîtront ici, classés par journée.")); return; }
  const order = { fav: 0, want: 1, done: 2, skip: 3 };
  // regroupement par journée
  const groups = {};
  mine.forEach(p => { const d = (p.days && p.days.length) ? p.days[0] : 0; (groups[d] = groups[d] || []).push(p); });
  Object.keys(groups).map(Number).sort((a, b) => a - b).forEach(d => {
    const day = DATA.days.find(x => x.num === d);
    const h = el("div", "fav-day-head");
    h.innerHTML = d === 0 ? `📌 Sans journée précise`
      : `<span class="dot" style="background:${day ? day.color : "#C1440E"}"></span> Jour ${d}${day ? " — " + esc(day.label) : ""}`;
    box.appendChild(h);
    groups[d].sort((a, b) => (order[statuses[a.id]] - order[statuses[b.id]]) || (b.interest || 0) - (a.interest || 0))
      .forEach(p => box.appendChild(placeItem(p)));
  });
}

/* ---------- Timeline ---------- */
function renderTimeline() {
  const box = $("#timeline"); box.innerHTML = "";
  let daysToShow;
  if (currentDay === "all") {
    // ordre : ... J8, J8ᴮ, J9, J9ᴮ, J10, J10ᴮ (chaque variante juste après sa journée)
    const base = DATA.days.filter(d => d.num < 100).map(d => d.num).sort((a, b) => a - b);
    daysToShow = [];
    base.forEach(n => { daysToShow.push(n); if (DATA.days.find(x => x.num === n + 100)) daysToShow.push(n + 100); });
  } else {
    daysToShow = [Number(currentDay)];
  }
  daysToShow.forEach(num => {
    const d = DATA.days.find(x => x.num === num); if (!d) return;
    const wrap = el("div", "tl-day");
    wrap.appendChild(el("h4", null, `<span class="dot" style="width:10px;height:10px;border-radius:50%;display:inline-block;background:${d.color}"></span> ${d.optionB ? esc(d.label) : "Jour " + d.num + " — " + esc(d.label)}`));
    // étapes = villes traversées (depuis le tracé) + lieux clés
    const stops = routeStopNames(num);
    stops.forEach(s => {
      const stop = el("div", "tl-stop tl-stop-click");
      stop.innerHTML = `<b>${esc(s.name)}</b><span class="tl-go">carte ▸</span>`;
      stop.addEventListener("click", () => goToStop(s));
      wrap.appendChild(stop);
    });
    box.appendChild(wrap);
  });
}
// noms de villes-étapes d'une journée (à partir des coordonnées du tracé, reliées aux villes connues)
const STOP_LABELS = {
  1: ["Rabat aéroport", "Casablanca (contournement)", "Settat", "Ben Guerir", "Marrakech"],
  2: ["Marrakech (journée libre)"],
  3: ["Marrakech", "Aït Ourir", "Taddert", "Tizi n'Tichka", "Agouim", "Aït-Ben-Haddou", "Ouarzazate"],
  4: ["Ouarzazate", "Skoura", "Kelaat M'Gouna", "Boumalne", "Tamellalt", "Lacets du Dadès"],
  5: ["Tamellalt", "Boumalne", "Tinghir", "Todra"],
  6: ["Todra", "Tinghir", "Tinjdad", "Jorf", "Rissani", "Erfoud", "Merzouga"],
  7: ["Hassilabied", "Merzouga", "Khamlia", "Merzouga"],
  8: ["Merzouga", "Erfoud", "Aoufous", "Errachidia", "Rich", "Tizi n'Talghamt", "Midelt"],
  9: ["Midelt", "Timahdite", "Azrou", "El Hajeb", "Meknès"],
  10: ["Meknès", "Khémisset", "Rabat aéroport"],
  108: ["Merzouga", "Erfoud", "Aoufous", "Errachidia", "Rich", "Midelt", "Zaïda", "Timahdite", "Azrou", "Ifrane", "Imouzzer Kandar", "Fès"],
  109: ["Fès — Bab Boujloud", "Bou Inania", "Nejjarine", "Al-Attarine", "Place Seffarine", "Tanneries Chouara"],
  110: ["Fès", "Meknès", "Khémisset", "Rabat aéroport"],
};
function goToStop(s) {
  const base = norm(String(s.name).split("(")[0].split("—")[0].trim());
  const cands = [base, base.split(" ")[0]].filter((v, i, a) => v && a.indexOf(v) === i);
  const active = PLACES.filter(x => !x.hidden && x.lat != null);
  const regions = [...new Set(active.map(x => x.region).filter(Boolean))];
  for (const q of cands) {
    if (q.length < 3) continue;
    const exact = active.find(x => norm(x.name) === q);
    if (exact) { goToPlace(exact.id); return afterStopNav(); }
    const reg = regions.find(r => norm(r).includes(q));
    if (reg) { goToRegion(reg); return afterStopNav(); }
    const contains = active.filter(x => norm(x.name).includes(q)).sort((a, b) => (b.interest || 0) - (a.interest || 0))[0];
    if (contains) { goToPlace(contains.id); return afterStopNav(); }
  }
  if (s.lat != null) { map.flyTo({ center: [s.lon, s.lat], zoom: 11, essential: true }); toast("Sur la carte : " + s.name); afterStopNav(); }
  else toast("Emplacement approximatif indisponible pour « " + s.name + " »");
}
function afterStopNav() { if (window.innerWidth < 900 && typeof setSheet === "function") setSheet("half"); }
function routeStopNames(num) {
  const route = DATA.routes.features.find(f => f.properties.day === num);
  const labels = STOP_LABELS[num] || [];
  const coords = route ? route.geometry.coordinates : [];
  return labels.map((name, i) => {
    const c = coords[Math.min(i, coords.length - 1)] || [null, null];
    return { name, lon: c[0], lat: c[1] };
  });
}

/* ---------- Fiche lieu ---------- */
function fact(dt, dd) { return dd ? `<dt>${dt}</dt><dd>${dd}</dd>` : ""; }
function openCard(id, fromList) {
  const p = byId[id]; if (!p) return;
  const st = statuses[id];
  const statusBadge = p.status ? `<span class="badge-line ${p.status === "verifie" ? "ok" : p.status === "a_reconfirmer" ? "mid" : "warn"}">${esc(p.statusLabel || "")}</span>` : "";
  const stars = p.interest ? `<span class="stars">${"★".repeat(p.interest)}${"☆".repeat(5 - p.interest)}</span> ${p.interest}/5` : "—";
  let coordNote = "";
  if (p.coordPrecision === "zone") coordNote = `<div class="coord-note">📍 Position <b>approximative</b> (secteur de la zone). Ouvrez Google Maps pour l'emplacement exact.</div>`;
  else if (p.coordPrecision == null) coordNote = `<div class="coord-note">📍 Coordonnées <b>à compléter</b> — utilisez le lien Google Maps ci-dessous.</div>`;
  let facts = "";
  facts += fact("📍 Région", esc(p.region));
  facts += fact("⭐ Intérêt", stars);
  if (p.rating) facts += fact("🌟 Note Google", `${p.rating}/5`);
  facts += fact("⏱️ Temps", esc(p.duree));
  facts += fact("🚗 Détour", esc(p.detour));
  facts += fact("🚶 Accès", esc(p.acces));
  facts += fact("ℹ️ Infos", esc(p.info));
  if (p.category === "restaurant") {
    facts += fact("🍴 Type", esc(p.restoType));
    facts += fact("💰 Budget", esc(p.budget));
    facts += fact("🥘 À commander", esc(p.commander));
  }
  if (p.category === "randonnee") {
    facts += fact("🧭 Départ", esc(p.depart));
    facts += fact("📏 Distance", esc(p.distance));
    facts += fact("⏱️ Durée", esc(p.duree_rando));
    facts += fact("↗️ Dénivelé", esc(p.denivele));
    facts += fact("⭐ Difficulté", esc(p.difficulte));
    facts += fact("🔁 Type", esc(p.boucle));
    facts += fact("❄️ Hiver", esc(p.hiver));
    facts += fact("👤 Encadrement", esc(p.guide));
  }
  if (p.days && p.days.length) facts += fact("🗓️ Journée(s)", p.days.map(x => x >= 100 ? ("Jour " + (x - 100) + " — Option B") : ("Jour " + x)).join(", "));
  let baseq = p.mapsQuery || p.name;
  if (!/maroc|morocco/i.test(baseq)) baseq += " Maroc";
  const q = encodeURIComponent(baseq);
  let gmaps, nav;
  if (p.mapsUrl) {
    // fiche Google exacte issue du fichier (repère officiel observé)
    gmaps = p.mapsUrl;
  } else if (p.placeId) {
    gmaps = `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${p.placeId}`;
  } else {
    gmaps = `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
  // navigation : vers le point exact quand on l'a, sinon par nom
  if (p.lat != null) nav = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  else nav = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
  // sources (liens cliquables)
  const srcHtml = (p.sources && p.sources.length)
    ? p.sources.map(s => `<a class="btn ghost small" href="${esc(s.url)}" target="_blank" rel="noopener">🔗 ${esc(s.label)}</a>`).join("")
    : (p.sourceUrl ? `<a class="btn ghost small" href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">🔗 Source</a>` : "");
  const userEditable = String(id).startsWith("U");
  $("#cardBody").innerHTML =
    `<div class="card-hero">
       <div class="card-head">
         <div class="ch-emoji">${p.emoji || "📍"}</div>
         <div><h2>${esc(p.name)}</h2><div class="ch-cat">${esc(p.categoryLabel || "")}${p.region ? " · " + esc(p.region) : ""}</div></div>
       </div>
       ${statusBadge ? `<div class="card-badges">${statusBadge}</div>` : ""}
     </div>
     <div class="card-content">
       ${p.selection ? `<div class="sel-banner">⭐ <b>Sélection</b>${p.selEtape ? " — " + esc(p.selEtape) : ""}${p.selWhy ? `<div class="sel-why">${esc(p.selWhy)}</div>` : ""}</div>` : ""}
       ${p.desc ? `<div class="card-desc">${esc(p.desc)}</div>` : ""}
       <dl class="card-facts">${facts}</dl>
       ${(p.hours && p.hours.length) ? `<div class="hours-box"><div class="hours-title">🕒 Horaires (Google — à reconfirmer sur place)</div>${p.hours.map(h => `<div class="hours-line">${esc(h)}</div>`).join("")}<div class="hours-warn">⚠️ Horaires spéciaux possibles autour du Nouvel An.</div></div>` : ""}
       ${coordNote}
       <div class="status-row">
         <button data-st="fav" class="${st === "fav" ? "on" : ""}">❤️ Favori</button>
         <button data-st="want" class="${st === "want" ? "on" : ""}">✅ À faire</button>
         <button data-st="done" class="${st === "done" ? "on" : ""}">✔️ Visité</button>
         <button data-st="skip" class="${st === "skip" ? "on" : ""}">❌ Non</button>
       </div>
       <div class="card-actions">
         <a class="btn primary" href="${nav}" target="_blank" rel="noopener">🧭 Naviguer avec Google Maps</a>
         <a class="btn" href="${gmaps}" target="_blank" rel="noopener">🗺️ Voir le repère</a>
         ${userEditable ? `<button class="btn small" id="editPlace">✏️ Modifier</button><button class="btn small" id="delPlace">🗑️ Supprimer</button>` : ""}
       </div>
       ${srcHtml ? `<div class="card-sources"><span class="cs-label">Sources :</span>${srcHtml}</div>` : ""}
     </div>`;
  $$("#cardBody .status-row button").forEach(b => b.addEventListener("click", () => setStatus(id, b.dataset.st)));
  if (userEditable) {
    $("#editPlace").addEventListener("click", () => openAddForm(p));
    $("#delPlace").addEventListener("click", () => deletePlace(id));
  }
  $("#placeCard").hidden = false;
  if (fromList && p.lat != null) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 11) });
}
function closeCard() { $("#placeCard").hidden = true; }

/* ---------- Recherche : suggestions + aller au lieu sur la carte ---------- */
function hideSuggest() { const b = $("#searchSuggest"); if (b) { b.hidden = true; b.innerHTML = ""; } }
function buildSuggest(raw) {
  const box = $("#searchSuggest"); if (!box) return;
  const q = norm((raw || "").trim());
  if (q.length < 2) { hideSuggest(); return; }
  const places = PLACES.filter(p => !p.hidden && p.lat != null);
  const regions = [...new Set(places.map(p => p.region).filter(Boolean))].filter(r => norm(r).includes(q)).slice(0, 3);
  const plHits = places.filter(p => norm(p.name).includes(q)).sort((a, b) => (b.interest || 0) - (a.interest || 0)).slice(0, 7);
  let html = "";
  regions.forEach(r => { html += `<button class="sg-row sg-region" data-region="${encodeURIComponent(r)}"><span class="sg-ic">📍</span><span class="sg-tx"><b>${esc(r)}</b><small>Secteur / région — voir la zone</small></span></button>`; });
  plHits.forEach(p => { html += `<button class="sg-row" data-id="${p.id}"><span class="sg-ic">${p.emoji || "📍"}</span><span class="sg-tx"><b>${esc(p.name)}</b><small>${esc(p.categoryLabel || "")}${p.region ? " · " + esc(p.region) : ""}</small></span></button>`; });
  if (!html) html = `<div class="sg-empty">Aucun lieu trouvé pour « ${esc(raw)} »</div>`;
  box.innerHTML = html; box.hidden = false;
  box.querySelectorAll(".sg-row").forEach(b => b.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    if (b.dataset.id) goToPlace(b.dataset.id);
    else if (b.dataset.region) goToRegion(decodeURIComponent(b.dataset.region));
  }));
}
function ensureVisibleDay(p) {
  if (currentDay !== "all") {
    const dn = Number(currentDay);
    const inDay = (p.days || []).includes(dn) || (p.days || []).includes(dn + 100);
    if (!inDay) selectDay("all");
  }
}
function goToPlace(id) {
  const p = byId[id]; if (!p || p.lat == null) return;
  hideSuggest();
  const sb = $("#searchBox"); if (sb) sb.value = p.name;
  filters.query = "";          // ne pas masquer les autres repères
  ensureVisibleDay(p);
  refresh();
  map.flyTo({ center: [p.lon, p.lat], zoom: 13, essential: true });
  openCard(id);
}
function goToRegion(region) {
  hideSuggest();
  const sb = $("#searchBox"); if (sb) sb.value = region;
  filters.query = "";
  if (currentDay !== "all") selectDay("all");
  refresh();
  const pts = PLACES.filter(p => !p.hidden && p.lat != null && p.region === region);
  if (!pts.length) return;
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  pts.forEach(p => { minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); });
  if (minLon === maxLon && minLat === maxLat) map.flyTo({ center: [minLon, minLat], zoom: 12, essential: true });
  else map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, maxZoom: 12, duration: 800 });
  toast(pts.length + " lieu(x) dans « " + region + " »");
}

/* ---------- Statuts personnels ---------- */
function setStatus(id, st) {
  if (statuses[id] === st) delete statuses[id]; else statuses[id] = st;
  LS.set(KEY_STATUS, statuses);
  openCard(id); refresh();
}
function cycleStatus(id) {
  const order = [undefined, "fav", "want", "done", "skip"];
  const cur = statuses[id]; const i = order.indexOf(cur);
  const next = order[(i + 1) % order.length];
  if (next === undefined) delete statuses[id]; else statuses[id] = next;
  LS.set(KEY_STATUS, statuses); refresh();
}

/* ---------- Sélecteur de journées ---------- */
function todayDayNum() {
  const now = new Date();
  const start = new Date("2026-12-26T00:00:00");
  const diff = Math.floor((now - start) / 86400000) + 1;
  return (diff >= 1 && diff <= 10) ? diff : null;
}
function buildDayNav() {
  const box = $("#dayPills"); box.innerHTML = "";
  const tnum = todayDayNum();
  const all = el("button", "day-pill" + (currentDay === "all" ? " active" : ""), `🗺️ Tous`);
  if (currentDay === "all") all.style.background = "#C1440E";
  all.addEventListener("click", () => selectDay("all"));
  box.appendChild(all);
  let dividerDone = false;
  DATA.days.forEach(d => {
    if (d.optionB && !dividerDone) { box.appendChild(el("span", "day-divider", "· Option B (Fès) ›")); dividerDone = true; }
    const lbl = d.optionB ? ("J" + (d.num - 100) + "ᴮ") : ("J" + d.num);
    const b = el("button", "day-pill" + (d.optionB ? " pill-b" : "") + (currentDay === d.num ? " active" : "") + (tnum === d.num ? " today-flag" : ""),
      `<span class="dot" style="background:${d.color}"></span> ${lbl}`);
    if (currentDay === d.num) b.style.background = d.color;
    b.title = d.label;
    b.addEventListener("click", () => selectDay(d.num));
    box.appendChild(b);
  });
}
function selectDay(day) {
  currentDay = day;
  buildDayNav();
  renderDaySummary();
  refresh();
  // zoom auto
  fitToDay(day);
  if (window.innerWidth < 900 && day !== "all") setSheet("half");
}
function fitToDay(day) {
  let coords = [];
  if (day === "all") {
    PLACES.forEach(p => { if (p.lat != null) coords.push([p.lon, p.lat]); });
  } else {
    const route = DATA.routes.features.find(f => f.properties.day === Number(day));
    if (route) coords = coords.concat(route.geometry.coordinates);
    PLACES.filter(p => p.days && p.days.includes(Number(day)) && p.lat != null).forEach(p => coords.push([p.lon, p.lat]));
  }
  if (!coords.length) return;
  const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(b, { padding: { top: 60, bottom: window.innerWidth < 900 ? 240 : 60, left: 40, right: 40 }, maxZoom: 12, duration: 700 });
}

/* ---------- Panneau (bottom sheet) ---------- */
function setSheet(state) { const p = $("#panel"); p.classList.remove("peek", "half", "full"); p.classList.add(state); }
(function initSheetDrag() {
  const handle = $("#sheetHandle"), panel = $("#panel");
  let startY = 0, startH = 0, dragging = false, moved = false;
  const vh = () => window.innerHeight;
  const heights = () => ({ peek: vh() * 0.28, half: vh() * 0.56, full: vh() - 106 });
  handle.addEventListener("pointerdown", (e) => {
    if (window.innerWidth >= 900) return;
    dragging = true; moved = false; startY = e.clientY; startH = panel.offsetHeight;
    panel.classList.add("dragging");
    try { handle.setPointerCapture(e.pointerId); } catch (x) {}
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    let h = Math.max(vh() * 0.12, Math.min(heights().full, startH + dy));
    panel.style.height = h + "px";
  });
  function end() {
    if (!dragging) return; dragging = false; panel.classList.remove("dragging");
    if (!moved) { // simple appui -> cycle
      panel.style.height = "";
      const next = panel.classList.contains("peek") ? "half" : panel.classList.contains("half") ? "full" : "peek";
      setSheet(next); return;
    }
    const h = panel.offsetHeight, H = heights();
    const opts = [["peek", H.peek], ["half", H.half], ["full", H.full]];
    opts.sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h));
    panel.style.height = ""; setSheet(opts[0][0]);
  }
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
})();
$$("#panelTabs button").forEach(b => b.addEventListener("click", () => {
  $$("#panelTabs button").forEach(x => x.classList.remove("active")); b.classList.add("active");
  $$(".tabpane").forEach(t => t.hidden = true);
  $("#tab-" + b.dataset.tab).hidden = false;
  if (window.innerWidth < 900 && $("#panel").classList.contains("peek")) setSheet("half");
}));

/* ---------- Filtres (drawer) ---------- */
function buildFilters() {
  const body = $("#filtersBody"); body.innerHTML = "";
  // catégories présentes
  const cats = {};
  PLACES.forEach(p => { cats[p.category] = (cats[p.category] || 0) + 1; });
  const g1 = el("div", "filter-group"); g1.appendChild(el("h5", null, "Catégories"));
  const grid = el("div", "cat-grid");
  Object.keys(cats).sort((a, b) => cats[b] - cats[a]).forEach(c => {
    const info = DATA.categories[c] || { emoji: "📍", label: c };
    const on = !filters.cats || filters.cats.has(c);
    const t = el("button", "cat-toggle" + (on ? "" : " off"), `<span class="c-emoji">${info.emoji}</span> ${esc(info.label)} <span class="c-n">${cats[c]}</span>`);
    t.dataset.cat = c;
    t.addEventListener("click", () => {
      if (!filters.cats) filters.cats = new Set(Object.keys(cats));
      if (filters.cats.has(c)) filters.cats.delete(c); else filters.cats.add(c);
      t.classList.toggle("off");
      liveApply();
    });
    grid.appendChild(t);
  });
  g1.appendChild(grid); body.appendChild(g1);
  // intérêt
  const g2 = el("div", "filter-group"); g2.appendChild(el("h5", null, "Intérêt minimum"));
  const seg2 = el("div", "seg");
  [[0, "Tous"], [3, "★3+"], [4, "★4+"], [5, "★5"]].forEach(([v, lbl]) => {
    const b = el("button", filters.minInterest === v ? "on" : "", lbl);
    b.addEventListener("click", () => { filters.minInterest = v; $$(".seg button", seg2).forEach(x => x.classList.remove("on")); b.classList.add("on"); liveApply(); });
    seg2.appendChild(b);
  });
  g2.appendChild(seg2); body.appendChild(g2);
  // détour
  const g3 = el("div", "filter-group"); g3.appendChild(el("h5", null, "Détour"));
  const seg3 = el("div", "seg");
  [["all", "Tous"], ["sur_la_route", "Sur la route"], ["petit_detour", "≤15 min"], ["detour_interessant", "15–30 min"]].forEach(([v, lbl]) => {
    const b = el("button", filters.detour === v ? "on" : "", lbl);
    b.addEventListener("click", () => { filters.detour = v; $$(".seg button", seg3).forEach(x => x.classList.remove("on")); b.classList.add("on"); liveApply(); });
    seg3.appendChild(b);
  });
  g3.appendChild(seg3); body.appendChild(g3);
  // fiabilité
  const g4 = el("div", "filter-group"); g4.appendChild(el("h5", null, "Fiabilité de l'information"));
  const seg4 = el("div", "seg");
  [["all", "Toutes"], ["verifie", "✅ Documenté"], ["a_reconfirmer", "🟡 À confirmer"], ["incertain", "⚠️ Incertain"]].forEach(([v, lbl]) => {
    const b = el("button", filters.status === v ? "on" : "", lbl);
    b.addEventListener("click", () => { filters.status = v; $$(".seg button", seg4).forEach(x => x.classList.remove("on")); b.classList.add("on"); liveApply(); });
    seg4.appendChild(b);
  });
  g4.appendChild(seg4); body.appendChild(g4);
  // favoris
  const g5 = el("div", "filter-group");
  const sw = el("div", "switch-row", `<span>❤️ Mes favoris / à faire seulement</span>`);
  const cb = el("input"); cb.type = "checkbox"; cb.checked = filters.favOnly;
  cb.addEventListener("change", () => { filters.favOnly = cb.checked; liveApply(); });
  sw.appendChild(cb); g5.appendChild(sw); body.appendChild(g5);
  // sélection de lieux par nuit
  const g6 = el("div", "filter-group");
  const sw2 = el("div", "switch-row", `<span>⭐ Sélection (lieux clés par nuit)</span>`);
  const cb2 = el("input"); cb2.type = "checkbox"; cb2.checked = filters.selOnly;
  cb2.addEventListener("change", () => { filters.selOnly = cb2.checked; liveApply(); });
  sw2.appendChild(cb2); g6.appendChild(sw2); body.appendChild(g6);
}
function liveApply() { refresh(); }
function updateFilterBadge() {
  let n = 0;
  if (filters.cats) { const total = new Set(PLACES.map(p => p.category)).size; if (filters.cats.size < total) n++; }
  if (filters.minInterest) n++;
  if (filters.detour !== "all") n++;
  if (filters.status !== "all") n++;
  if (filters.favOnly) n++;
  if (filters.selOnly) n++;
  if (filters.around) n++;
  if (filters.maxVisitMin != null) n++;
  const b = $("#filterCount"); b.hidden = n === 0; b.textContent = n;
}

/* ---------- Position (GPS via le contrôle MapLibre, repli centre carte) ---------- */
function resolvePosition(onDone) {
  if (userPos) return onDone(userPos, "gps");
  if (!geoCtrl || !navigator.geolocation) { const c = map.getCenter(); return onDone({ lat: c.lat, lon: c.lng }, "map"); }
  toast("Recherche de votre position…");
  pendingPos = onDone;
  try { geoCtrl.trigger(); } catch (e) {}
  setTimeout(() => {
    if (pendingPos === onDone) { pendingPos = null; const c = map.getCenter(); toast("Position GPS indisponible : centre de la carte utilisé."); onDone({ lat: c.lat, lon: c.lng }, "map"); }
  }, 12000);
}

/* ---------- Autour de moi ---------- */
function aroundMe() {
  openModal("📍 Autour de moi", `
    <p class="help">Choisissez un rayon. L'application utilise votre position GPS si elle est disponible, sinon le centre de la carte actuellement affichée.</p>
    <div class="seg" id="radiusSeg">
      <button data-km="5">5 km</button><button data-km="10">10 km</button>
      <button data-km="25">25 km</button><button data-km="50">50 km</button>
      <button data-km="0">Retirer le filtre</button>
    </div>`);
  $$("#radiusSeg button").forEach(b => b.addEventListener("click", () => {
    const km = Number(b.dataset.km);
    if (!km) { filters.around = null; closeModal(); refresh(); toast("Filtre « autour de moi » retiré"); return; }
    closeModal();
    resolvePosition((pos, src) => {
      filters.around = { lat: pos.lat, lon: pos.lon, km };
      refresh();
      map.flyTo({ center: [pos.lon, pos.lat], zoom: km <= 10 ? 12 : km <= 25 ? 10.5 : 9 });
      const n = visiblePlaces().length;
      toast(n + " lieu(x) dans " + km + " km" + (src === "map" ? " (centre de la carte)" : ""));
      if (window.innerWidth < 900) setSheet("half");
    });
  }));
}

/* ---------- Que faire maintenant ? ---------- */
function whatNow() {
  openModal("🎯 Que faire maintenant ?", `
    <p class="help">Choisissez le temps dont vous disposez. L'application propose des lieux compatibles proches de la zone actuellement affichée${userPos ? " ou de votre position" : ""}.</p>
    <div class="seg" id="timeSeg">
      <button data-min="30">30 min</button><button data-min="60">1 heure</button>
      <button data-min="120">2 heures</button><button data-min="300">Demi-journée</button>
    </div>
    <p class="help" style="margin-top:10px">Basé sur les champs durée, détour, catégorie et intérêt. C'est une aide simple, pas une optimisation parfaite.</p>`);
  $$("#timeSeg button").forEach(b => b.addEventListener("click", () => {
    const mn = Number(b.dataset.min);
    filters.maxVisitMin = mn;
    closeModal();
    // centre = position GPS si dispo sinon centre carte
    const c = userPos ? [userPos.lon, userPos.lat] : [map.getCenter().lng, map.getCenter().lat];
    const cand = PLACES.filter(p => p.lat != null && p.category !== "vigilance" && p.category !== "hebergement")
      .filter(p => { const v = durationToMin(p.duree); return v == null || v <= mn; })
      .map(p => ({ p, d: haversine(c[1], c[0], p.lat, p.lon) }))
      .filter(x => x.d < 60)
      .sort((a, b) => (b.p.interest || 0) - (a.p.interest || 0) || a.d - b.d)
      .slice(0, 12);
    refresh();
    setSheet("half");
    $$("#panelTabs button").forEach(x => x.classList.remove("active")); $("#panelTabs button[data-tab=list]").classList.add("active");
    $$(".tabpane").forEach(t => t.hidden = true); $("#tab-list").hidden = false;
    if (cand.length) { toast(cand.length + " idées pour " + (mn >= 300 ? "une demi-journée" : mn >= 60 ? mn / 60 + " h" : mn + " min")); openCard(cand[0].p.id, true); }
    else toast("Aucune idée trouvée dans la zone affichée — dézoomez un peu.");
  }));
}
function clearWhatNow() { if (filters.maxVisitMin != null) { filters.maxVisitMin = null; refresh(); } }

/* ---------- Aujourd'hui ---------- */
function goToday() {
  const n = todayDayNum();
  if (n) { selectDay(n); toast("Aujourd'hui : Jour " + n); }
  else {
    openModal("📅 Aujourd'hui", `<p class="help">La date actuelle n'est pas comprise dans le voyage (26 déc. 2026 → 4 janv. 2027). Choisissez une journée :</p>
      <div class="seg" id="pickDay">${DATA.days.map(d => `<button data-d="${d.num}">J${d.num}</button>`).join("")}</div>`);
    $$("#pickDay button").forEach(b => b.addEventListener("click", () => { closeModal(); selectDay(Number(b.dataset.d)); }));
  }
}

/* ---------- Géolocalisation ---------- */
function locate() { if (geoCtrl) { try { geoCtrl.trigger(); } catch (e) {} } else toast("Géolocalisation non disponible."); }

/* ---------- Ajouter / modifier un lieu ---------- */
function enterAddMode() {
  addMode = true; $("#addHint").hidden = false; map.getCanvas().style.cursor = "crosshair";
  toast("Touchez la carte à l'endroit du lieu");
}
function exitAddMode() { addMode = false; $("#addHint").hidden = true; map.getCanvas().style.cursor = ""; }
function openAddForm(existing, lnglat) {
  const p = existing || {};
  const lat = lnglat ? lnglat.lat : p.lat;
  const lon = lnglat ? lnglat.lng : p.lon;
  const catOpts = Object.keys(DATA.categories).map(c => `<option value="${c}" ${p.category === c ? "selected" : ""}>${DATA.categories[c].emoji} ${DATA.categories[c].label}</option>`).join("");
  const dayOpts = `<option value="">—</option>` + DATA.days.map(d => `<option value="${d.num}" ${(p.days && p.days[0] === d.num) ? "selected" : ""}>Jour ${d.num} — ${esc(d.label)}</option>`).join("");
  openModal(existing ? "✏️ Modifier le lieu" : "➕ Ajouter un lieu", `
    <div class="form-row"><label>Nom du lieu *</label><input id="f_name" value="${esc(p.name || "")}"></div>
    <div class="form-two">
      <div class="form-row"><label>Catégorie</label><select id="f_cat">${catOpts}</select></div>
      <div class="form-row"><label>Journée</label><select id="f_day">${dayOpts}</select></div>
    </div>
    <div class="form-two">
      <div class="form-row"><label>Intérêt</label><select id="f_int"><option value="">—</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${p.interest === n ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}</select></div>
      <div class="form-row"><label>Temps conseillé</label><input id="f_dur" value="${esc(p.duree || "")}" placeholder="ex. 30–45 min"></div>
    </div>
    <div class="form-row"><label>Description</label><textarea id="f_desc">${esc(p.desc || "")}</textarea></div>
    <div class="form-two">
      <div class="form-row"><label>Latitude</label><input id="f_lat" value="${lat != null ? lat : ""}" inputmode="decimal"></div>
      <div class="form-row"><label>Longitude</label><input id="f_lon" value="${lon != null ? lon : ""}" inputmode="decimal"></div>
    </div>
    <div class="form-row"><label>Lien Google Maps (facultatif)</label><input id="f_maps" value="${esc(p.mapsUrl || "")}" placeholder="https://..."></div>
    <div class="form-row"><label>Notes personnelles</label><textarea id="f_notes">${esc(p.notes || "")}</textarea></div>
    <div class="card-actions"><button class="btn primary" id="savePlace">Enregistrer</button><button class="btn" id="cancelForm">Annuler</button></div>
  `);
  $("#cancelForm").addEventListener("click", closeModal);
  $("#savePlace").addEventListener("click", () => {
    const name = $("#f_name").value.trim();
    if (!name) { toast("Le nom est obligatoire."); return; }
    const cat = $("#f_cat").value;
    const day = $("#f_day").value ? [Number($("#f_day").value)] : [];
    const latv = parseFloat($("#f_lat").value), lonv = parseFloat($("#f_lon").value);
    const rec = {
      id: existing ? existing.id : "U" + Date.now(),
      name, category: cat, categoryLabel: (DATA.categories[cat] || {}).label || "Lieu",
      emoji: (DATA.categories[cat] || {}).emoji || "📍", region: "Ajouté par moi", days: day,
      lat: isFinite(latv) ? latv : null, lon: isFinite(lonv) ? lonv : null,
      coordPrecision: (isFinite(latv) && isFinite(lonv)) ? "precise" : null,
      interest: $("#f_int").value ? Number($("#f_int").value) : null,
      duree: $("#f_dur").value.trim() || null, detour: null, detourClass: null,
      desc: $("#f_desc").value.trim() || null, notes: $("#f_notes").value.trim() || null,
      mapsUrl: $("#f_maps").value.trim() || null, status: null, statusLabel: null, userAdded: true,
    };
    saveUserPlace(rec);
    closeModal(); rebuildIndex(); refresh();
    toast(existing ? "Lieu modifié" : "Lieu ajouté ✅");
    if (rec.lat != null) { openCard(rec.id, true); }
  });
}
function saveUserPlace(rec) {
  const i = added.findIndex(x => x.id === rec.id);
  if (i >= 0) added[i] = rec; else added.push(rec);
  LS.set(KEY_ADDED, added);
}
function deletePlace(id) {
  openModal("🗑️ Supprimer", `<p>Supprimer définitivement ce lieu ajouté ?</p>
    <div class="card-actions"><button class="btn primary" id="okDel">Oui, supprimer</button><button class="btn" id="noDel">Annuler</button></div>`);
  $("#noDel").addEventListener("click", closeModal);
  $("#okDel").addEventListener("click", () => {
    added = added.filter(x => x.id !== id); LS.set(KEY_ADDED, added);
    delete statuses[id]; LS.set(KEY_STATUS, statuses);
    closeModal(); closeCard(); rebuildIndex(); refresh(); toast("Lieu supprimé");
  });
}

/* ---------- Téléchargement de la carte hors-ligne ---------- */
function tripBounds(pad) {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90, has = false;
  PLACES.forEach(p => { if (p.lat != null) { has = true; minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); } });
  DATA.routes.features.forEach(f => f.geometry.coordinates.forEach(c => { has = true; minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); }));
  if (!has) return null;
  pad = pad || 0.12;
  return { minLon: minLon - pad, maxLon: maxLon + pad, minLat: minLat - pad, maxLat: maxLat + pad };
}
function offlineTileList(zooms) {
  const b = tripBounds(); if (!b) return [];
  const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); };
  const subs = ["a", "b", "c", "d"]; const urls = [];
  zooms.forEach(z => {
    const x0 = lon2x(b.minLon, z), x1 = lon2x(b.maxLon, z), y0 = lat2y(b.maxLat, z), y1 = lat2y(b.minLat, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      urls.push(`https://${subs[(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`);
    }
  });
  return urls;
}
async function downloadOfflineMap(zooms, statusEl) {
  const urls = offlineTileList(zooms);
  const total = urls.length; let done = 0, ok = 0, idx = 0;
  const upd = () => { if (statusEl) statusEl.innerHTML = `Téléchargement… <b>${done} / ${total}</b> tuiles`; };
  upd();
  async function worker() {
    while (idx < urls.length) {
      const u = urls[idx++];
      try { await fetch(u, { mode: "no-cors", cache: "reload" }); ok++; } catch (e) {}
      done++; if (done % 20 === 0) upd();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (statusEl) statusEl.innerHTML = `✅ <b>Carte hors-ligne prête</b> (${ok}/${total} tuiles). La zone du voyage s'affichera sans réseau (fond « 🗺️ Plan »).`;
}

/* ---------- Import / export (gestion du voyage) ---------- */
function openManage() {
  const nAdded = added.length, nStatus = Object.keys(statuses).length;
  openModal("⚙️ Gestion du voyage", `
    <p class="help">Vos données personnelles (favoris, statuts, lieux ajoutés) sont enregistrées sur cet appareil.
    Vous avez <b>${nAdded}</b> lieu(x) ajouté(s) et <b>${nStatus}</b> statut(s).</p>
    <div class="card-actions">
      <button class="btn primary" id="doExport">📤 Exporter mes données</button>
      <label class="btn" style="cursor:pointer">📥 Importer un fichier<input type="file" id="importFile" accept="application/json,.json" hidden></label>
    </div>
    <div class="hr"></div>
    <p class="help"><b>📶 Carte hors-ligne</b> — l'application, les journées, les lieux, les fiches, les favoris et les tracés fonctionnent déjà sans réseau. Téléchargez ci-dessous le <b>fond de carte de la zone du voyage</b> (fond « 🗺️ Plan ») pour l'afficher aussi sans réseau — très utile dans le désert et la montagne. À faire de préférence en Wi-Fi.</p>
    <div class="card-actions"><button class="btn primary" id="dlOffline">⬇️ Télécharger la carte de la zone</button></div>
    <div id="offlineStatus" class="help" style="margin-top:8px"></div>
    <p class="help" style="margin-top:12px">Le satellite et le relief ne sont pas prévus hors ligne. Journée du jour calculée d'après les dates du voyage. Heure locale du Maroc : GMT (à revérifier avec vos billets).</p>
  `);
  $("#doExport").addEventListener("click", exportData);
  $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); });
  const dl = $("#dlOffline");
  dl.addEventListener("click", async () => {
    const zooms = [6, 7, 8, 9, 10, 11, 12];
    const urls = offlineTileList(zooms);
    const mb = Math.max(1, Math.round(urls.length * 0.02));
    const st = $("#offlineStatus");
    if (dl.dataset.armed !== "1") {
      dl.dataset.armed = "1"; dl.textContent = "⬇️ Lancer le téléchargement";
      st.innerHTML = `Environ <b>${urls.length}</b> tuiles (~${mb} Mo). Connectez-vous en Wi-Fi, puis appuyez à nouveau pour lancer.`;
      return;
    }
    dl.disabled = true; dl.textContent = "Téléchargement en cours…";
    await downloadOfflineMap(zooms, st);
    dl.textContent = "✅ Terminé";
  });
}
function exportData() {
  const payload = { app: "road-trip-maroc", version: 1, exportedAt: new Date().toISOString(), statuses, added };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "road-trip-maroc-mes-donnees.json"; document.body.appendChild(a); a.click(); a.remove();
  toast("Export téléchargé");
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (e) { toast("Fichier illisible (JSON invalide)."); return; }
    if (!data || (data.app && data.app !== "road-trip-maroc") || (!data.added && !data.statuses)) { toast("Ce fichier n'est pas un export Road Trip Maroc."); return; }
    const nA = (data.added || []).length, nS = Object.keys(data.statuses || {}).length;
    openModal("📥 Importer", `<p class="help">Fichier valide : <b>${nA}</b> lieu(x) et <b>${nS}</b> statut(s). Que faire ?</p>
      <div class="card-actions">
        <button class="btn primary" id="impMerge">Fusionner</button>
        <button class="btn" id="impReplace">Remplacer</button>
        <button class="btn ghost" id="impCancel">Annuler</button>
      </div>
      <p class="help">« Fusionner » ajoute sans écraser vos données existantes. « Remplacer » efface vos données actuelles.</p>`);
    $("#impCancel").addEventListener("click", closeModal);
    $("#impMerge").addEventListener("click", () => {
      (data.added || []).forEach(r => { if (!added.find(x => x.id === r.id)) added.push(r); });
      Object.assign(statuses, data.statuses || {});
      finishImport();
    });
    $("#impReplace").addEventListener("click", () => {
      added = data.added || []; statuses = data.statuses || {};
      finishImport();
    });
    function finishImport() {
      LS.set(KEY_ADDED, added); LS.set(KEY_STATUS, statuses);
      closeModal(); rebuildIndex(); refresh(); buildFilters(); toast("Import terminé ✅");
    }
  };
  reader.readAsText(file);
}

/* ---------- Modale générique ---------- */
function openModal(title, html) { $("#modalTitle").textContent = title; $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }

/* ---------- Ajustements d'itinéraire appliqués au chargement (idempotent) ----------
   (Jour 2 = Marrakech ; Jour 3 = Marrakech → Tichka → Aït-Ben-Haddou → Ouarzazate ;
    Imlil retiré). Centralisé ici pour qu'une simple mise à jour de app.js suffise. */
function applyItineraryTweaks(D) {
  return; // désormais intégré directement dans les données (roadtrip.json)
  if (!D || !D.days) return;
  const days = {}; D.days.forEach(x => days[x.num] = x);
  if (days[2]) Object.assign(days[2], { label: "Marrakech — journée libre (médina, souks, jardins)", start: "Marrakech", end: "Marrakech", night: "Marrakech", km: 0, drive: "sur place", intensity: "🟢" });
  if (days[3]) Object.assign(days[3], { label: "Marrakech → Tichka → Aït-Ben-Haddou → Ouarzazate", start: "Marrakech", end: "Ouarzazate", night: "Ouarzazate", km: 330, drive: "6–7 h", intensity: "🔴" });
  if (days[4]) Object.assign(days[4], { label: "Ouarzazate → Skoura → Dadès", start: "Ouarzazate", end: "Dadès", night: "Tamellalt / Dadès" });
  const IMLIL = new Set(["R1", "R2", "V5"]);
  for (let n = 35; n <= 54; n++) IMLIL.add("L0" + n);
  D.places.forEach(p => {
    if (p.id === "H2") { p.name = "Nuit à Marrakech (2e nuit)"; p.region = "Marrakech"; p.days = [2]; return; }
    if (p.id === "H3") { p.name = "Nuit à Ouarzazate"; p.region = "Ouarzazate"; p.days = [3]; p.lat = 30.9200; p.lon = -6.8936; p.coordPrecision = "zone"; return; }
    if (IMLIL.has(p.id) || p.region === "Imlil et Asni") { p.days = []; p.hidden = true; return; }
    if (p.region === "Marrakech") { const s = new Set(p.days || []); s.add(1); s.add(2); p.days = [...s].sort((a, b) => a - b); }
    if (p.region === "Ouarzazate") { const s = new Set(p.days || []); s.add(3); s.add(4); p.days = [...s].sort((a, b) => a - b); }
  });
  if (!D.places.some(p => p.id === "N6")) {
    const c = (D.categories && D.categories.panorama) || { label: "Panorama / belvédère", emoji: "🌄" };
    D.places.push({
      id: "N6", name: "Vallée de l'Ounila (route de Telouet)", category: "panorama",
      categoryLabel: c.label, emoji: c.emoji, region: "Aït-Ben-Haddou et Tichka", days: [3],
      lat: 31.19, lon: -7.18, coordPrecision: "zone", interest: 5, duree: "1–2 h",
      detour: "détour panoramique", detourClass: "detour_interessant",
      desc: "Vallée peinte de villages de terre entre Telouet et Aït-Ben-Haddou : route très photogénique. Portions de piste par endroits — à éviter par neige ou pluie ; sinon un des plus beaux passages du secteur.",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=Vall%C3%A9e+de+l%27Ounila+Telouet+Maroc",
      mapsQuery: "Vallée de l'Ounila Telouet", status: "a_reconfirmer",
      statusLabel: "🟡 Route panoramique ; état de la piste à confirmer", sourceUrl: null,
    });
  }
  // Tracés J3 et J4 (on retire l'ancien J2 Marrakech→Imlil)
  const RC = {
    marrakech: [-7.9811, 31.6295], ait_ourir: [-7.6640, 31.5640], touama: [-7.5500, 31.4700],
    taddert: [-7.4020, 31.2940], tichka: [-7.3806, 31.2917], agouim: [-7.4420, 31.1550],
    tisselday: [-7.3030, 31.0790], tabourahte: [-7.1600, 31.0600], ait_ben_haddou: [-7.1316, 31.0472],
    ouarzazate: [-6.8936, 30.9200], skoura: [-6.5560, 31.0610], kelaat: [-6.1300, 31.2380],
    boumalne: [-5.9900, 31.3650], tamellalt: [-5.9000, 31.4900], timzzillite: [-5.8760, 31.5670],
  };
  const col3 = days[3] ? days[3].color : "#D4A017", col4 = days[4] ? days[4].color : "#6E8B3D";
  D.routes.features = D.routes.features.filter(f => ![2, 3, 4].includes(f.properties.day));
  D.routes.features.push({
    type: "Feature", properties: { day: 3, dayId: "day-03", label: days[3] ? days[3].label : "Jour 3", km: 330, drive: "6–7 h", color: col3, night: "Ouarzazate", kind: "principale" },
    geometry: { type: "LineString", coordinates: ["marrakech", "ait_ourir", "touama", "taddert", "tichka", "agouim", "tisselday", "tabourahte", "ait_ben_haddou", "ouarzazate"].map(k => RC[k]) },
  });
  D.routes.features.push({
    type: "Feature", properties: { day: 4, dayId: "day-04", label: days[4] ? days[4].label : "Jour 4", km: 240, drive: "4 h–5 h", color: col4, night: "Tamellalt / Dadès", kind: "principale" },
    geometry: { type: "LineString", coordinates: ["ouarzazate", "skoura", "kelaat", "boumalne", "tamellalt", "timzzillite"].map(k => RC[k]) },
  });
}

/* ---------- Reconstruction index ---------- */
function rebuildIndex() {
  PLACES = DATA.places.concat(added);
  byId = {}; PLACES.forEach(p => byId[p.id] = p);
}

/* ---------- Ajout des couches carte ---------- */
function addLayers() {
  // icônes (anneau coloré par catégorie)
  const cats = new Set(PLACES.map(p => p.category));
  cats.forEach(c => {
    const info = DATA.categories[c] || { emoji: "📍" };
    if (!map.hasImage("ic_" + c)) map.addImage("ic_" + c, makeEmojiIcon(info.emoji, CAT_COLORS[c] || "#C1440E"));
  });
  if (!map.hasImage("ic_fav")) map.addImage("ic_fav", makeEmojiIcon("❤️", "#E23E57"));
  if (!map.hasImage("ic_done")) map.addImage("ic_done", makeEmojiIcon("✔️", "#6E8B3D"));

  // routes
  map.addSource("routes", { type: "geojson", data: DATA.routes });
  map.addLayer({
    id: "routes-line", type: "line", source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6], "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "routes-hit", type: "line", source: "routes",
    paint: { "line-color": "#000", "line-width": 16, "line-opacity": 0 },
  });

  // places (clustered)
  map.addSource("places", {
    type: "geojson", data: { type: "FeatureCollection", features: [] },
    cluster: true, clusterRadius: 42, clusterMaxZoom: 11,
  });
  map.addLayer({
    id: "clusters-halo", type: "circle", source: "places", filter: ["has", "point_count"],
    paint: {
      "circle-color": "#C1440E",
      "circle-radius": ["step", ["get", "point_count"], 21, 10, 25, 30, 31],
      "circle-opacity": 0.18,
    },
  });
  map.addLayer({
    id: "clusters", type: "circle", source: "places", filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#D4682A", 10, "#C1440E", 30, "#9E3608"],
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 30, 26],
      "circle-opacity": 0.96, "circle-stroke-width": 2.5, "circle-stroke-color": "#fff",
    },
  });
  // pastille "+" au centre des clusters (image, sans dépendance aux polices/glyphs)
  if (!map.hasImage("ic_cluster")) map.addImage("ic_cluster", makeClusterIcon());
  map.addLayer({
    id: "cluster-plus", type: "symbol", source: "places", filter: ["has", "point_count"],
    layout: { "icon-image": "ic_cluster", "icon-size": 0.5, "icon-allow-overlap": true },
  });
  map.addLayer({
    id: "unclustered", type: "symbol", source: "places", filter: ["!", ["has", "point_count"]],
    layout: {
      "icon-image": ["get", "icon"], "icon-size": 0.55, "icon-allow-overlap": true, "icon-anchor": "bottom",
    },
  });

  // interactions
  map.on("click", "clusters", (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
    map.getSource("places").getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
      if (err) return; map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.2 });
    });
  });
  map.on("click", "unclustered", (e) => {
    const f = e.features[0]; showPointPopup(f);
  });
  map.on("click", "routes-hit", (e) => {
    const f = e.features[0]; const pr = f.properties;
    const d = DATA.days.find(x => x.num === pr.day);
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat)
      .setHTML(`<div class="route-pop"><div class="mp-title"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${pr.color};display:inline-block"></span> Jour ${pr.day}</div>
        <div class="mp-sub">${esc(pr.label)}</div>
        <div class="mp-sub">🚗 ${pr.km} km · ⏱️ ${esc(pr.drive)}</div>
        <div class="mp-sub">🌙 ${esc(pr.night)}</div>
        <button class="mp-link" onclick="window.__selDay(${pr.day})">Afficher cette journée</button></div>`).addTo(map);
  });
  ["clusters", "unclustered", "routes-hit"].forEach(l => {
    map.on("mouseenter", l, () => map.getCanvas().style.cursor = addMode ? "crosshair" : "pointer");
    map.on("mouseleave", l, () => map.getCanvas().style.cursor = addMode ? "crosshair" : "");
  });
  // clic carte (mode ajout)
  map.on("click", (e) => {
    if (!addMode) return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ["unclustered", "clusters"] });
    if (hit.length) return;
    exitAddMode(); openAddForm(null, e.lngLat);
  });
}
window.__selDay = (d) => { if (popup) popup.remove(); selectDay(d); };

function showPointPopup(f) {
  const p = byId[f.properties.id]; if (!p) return;
  if (popup) popup.remove();
  const stars = p.interest ? " · " + "★".repeat(p.interest) : "";
  popup = new maplibregl.Popup({ closeButton: true, offset: 24 }).setLngLat(f.geometry.coordinates)
    .setHTML(`<div class="mp-title">${p.emoji || "📍"} ${esc(p.name)}</div>
      <div class="mp-sub">${esc(p.categoryLabel || "")}${stars}</div>
      <button class="mp-link" onclick="window.__openCard('${p.id}')">Voir la fiche ▸</button>`).addTo(map);
}
window.__openCard = (id) => { if (popup) popup.remove(); openCard(id); };

/* ---------- Légende ---------- */
function buildLegend() {
  const box = $("#mapLegend");
  box.innerHTML = `<b>Tracés = corridors indicatifs</b>` +
    DATA.days.slice(0, 5).map(d => `<div class="row"><span class="swatch" style="background:${d.color}"></span>J${d.num}</div>`).join("") +
    `<div class="row">…</div>`;
}

/* ---------- Vraies routes (routage à la volée + cache hors ligne) ---------- */
function updateRoutesSource() {
  const rf = DATA.routes.features.filter(f => currentDay === "all" ? true : f.properties.day === Number(currentDay));
  const rsrc = map.getSource("routes"); if (rsrc) rsrc.setData({ type: "FeatureCollection", features: rf });
}
function captureWaypoints() {
  DATA.routes.features.forEach(f => { ROUTE_WAYPOINTS[f.properties.day] = f.geometry.coordinates.map(c => c.slice()); });
}
function applyCachedRoutes() {
  let n = 0;
  DATA.routes.features.forEach(f => {
    const g = routeGeoCache[f.properties.day];
    if (g && g.length > 1) { f.geometry.coordinates = g; f.properties.real = true; n++; }
  });
  if (n) updateRoutesSource();
}
async function fetchRealRoutes() {
  if (!navigator.onLine) return;
  let first = true;
  for (const f of DATA.routes.features) {
    const day = f.properties.day;
    if (routeGeoCache[day]) continue;
    const wps = ROUTE_WAYPOINTS[day];
    if (!wps || wps.length < 2) continue;
    const coordStr = wps.map(c => c[0].toFixed(5) + "," + c[1].toFixed(5)).join(";");
    try {
      const url = "https://router.project-osrm.org/route/v1/driving/" + coordStr + "?overview=full&geometries=geojson";
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const geo = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
        if (geo && geo.length > 1) {
          routeGeoCache[day] = geo; LS.set(KEY_ROUTES, routeGeoCache);
          f.geometry.coordinates = geo; f.properties.real = true;
          updateRoutesSource();
          if (first) { first = false; toast("Tracés routiers réels chargés ✅ (enregistrés pour le hors-ligne)"); }
        }
      }
    } catch (e) { /* hors ligne / service indisponible : on garde le corridor */ }
    await new Promise(res => setTimeout(res, 450)); // courtoisie envers le serveur public
  }
}

/* ---------- Démarrage ---------- */
async function init() {
  try { DATA = await loadData(); }
  catch (e) { document.body.innerHTML = "<p style='padding:24px'>Impossible de charger les données du voyage (data/roadtrip.json). Ouvrez l'application via le lanceur « Ouvrir Road Trip ».</p>"; return; }
  applyItineraryTweaks(DATA);
  rebuildIndex();
  $("#brandSub").textContent = DATA.meta.subtitle || "";

  map = new maplibregl.Map({
    container: "map", style: baseStyle(),
    center: [-6.6, 31.6], zoom: 5.4, attributionControl: true, hash: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  geoCtrl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true }, trackUserLocation: true,
    showUserLocation: true, showAccuracyCircle: true,
  });
  map.addControl(geoCtrl, "top-right");
  geoCtrl.on("geolocate", (e) => {
    userPos = { lat: e.coords.latitude, lon: e.coords.longitude };
    if (pendingPos) { const cb = pendingPos; pendingPos = null; cb(userPos, "gps"); }
  });
  geoCtrl.on("error", () => {
    if (pendingPos) { const cb = pendingPos; pendingPos = null; const c = map.getCenter(); toast("Position GPS indisponible : centre de la carte utilisé."); cb({ lat: c.lat, lon: c.lng }, "map"); }
    else toast("Position indisponible (autorisation refusée ou GPS coupé).");
  });
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-left");

  let ready = false;
  function onReady() {
    if (ready) return; ready = true;
    addLayers();
    captureWaypoints();
    applyCachedRoutes();
    buildDayNav();
    buildFilters();
    setBasemap(prefs.basemap || "plan");
    refresh();
    fitToDay("all");
    fetchRealRoutes(); // arrière-plan : récupère les vraies routes et les met en cache
    if (!prefs.seen) { toast("Bienvenue ! Choisissez une journée en haut, ou explorez la carte.", 4200); prefs.seen = true; LS.set(KEY_PREFS, prefs); }
  }
  map.on("load", onReady);
  // Filet de sécurité : l'événement 'load' attend les premières tuiles ;
  // si le réseau est lent ou indisponible, on démarre dès que le style est prêt.
  const readyTimer = setInterval(() => { if (map.isStyleLoaded()) { clearInterval(readyTimer); onReady(); } }, 400);
  setTimeout(() => clearInterval(readyTimer), 9000);

  wireUI();
  registerSW();
}

function wireUI() {
  $("#btnToday").addEventListener("click", goToday);
  $("#btnManage").addEventListener("click", openManage);
  $("#btnFilters").addEventListener("click", () => { buildFilters(); $("#filtersDrawer").hidden = false; });
  $("#closeFilters").addEventListener("click", () => $("#filtersDrawer").hidden = true);
  $("#filtersDrawer").addEventListener("click", (e) => { if (e.target.id === "filtersDrawer") $("#filtersDrawer").hidden = true; });
  $("#filtApply").addEventListener("click", () => { $("#filtersDrawer").hidden = true; if (window.innerWidth < 900) setSheet("half"); });
  $("#filtAll").addEventListener("click", () => { filters.cats = null; buildFilters(); refresh(); });
  $("#filtNone").addEventListener("click", () => { filters.cats = new Set(); buildFilters(); refresh(); });
  $("#filtStar").addEventListener("click", () => { filters.minInterest = 4; buildFilters(); refresh(); toast("Incontournables (★4+)"); });
  $("#btnAround").addEventListener("click", aroundMe);
  $("#btnWhatNow").addEventListener("click", whatNow);
  $("#btnAddPlace").addEventListener("click", () => { if (addMode) exitAddMode(); else enterAddMode(); });
  $("#cancelAdd").addEventListener("click", exitAddMode);
  $("#btnLocate").addEventListener("click", () => locate());
  $("#btnBigMap").addEventListener("click", () => {
    const full = document.body.classList.toggle("map-full");
    $("#panel").hidden = full;
    const btn = $("#btnBigMap");
    btn.textContent = full ? "⤡" : "⤢";
    btn.title = full ? "Afficher la liste" : "Agrandir la carte";
    if (map) setTimeout(() => map.resize(), 80);
  });
  $("#closeCard").addEventListener("click", closeCard);
  $("#placeCard").addEventListener("click", (e) => { if (e.target.id === "placeCard") closeCard(); });
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  $$("#basemapSwitch button").forEach(b => b.addEventListener("click", () => setBasemap(b.dataset.base)));
  const searchBox = $("#searchBox");
  if (searchBox) {
    searchBox.addEventListener("input", (e) => { filters.query = norm(e.target.value.trim()); refresh(); buildSuggest(e.target.value); });
    searchBox.addEventListener("focus", (e) => { if (e.target.value.trim()) buildSuggest(e.target.value); });
    searchBox.addEventListener("blur", () => setTimeout(hideSuggest, 150));
    searchBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const first = $("#searchSuggest .sg-row"); if (first) first.dispatchEvent(new MouseEvent("mousedown")); }
      else if (e.key === "Escape") { hideSuggest(); }
    });
  }
  // sélecteur de fond de carte : toujours visible, flottant sur la carte
  const bm = $("#basemapSwitch"); if (bm && $("#mapWrap")) { $("#mapWrap").appendChild(bm); bm.classList.add("floating"); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeCard(); closeModal(); $("#filtersDrawer").hidden = true; if (addMode) exitAddMode(); } });
}

/* ---------- Service Worker ---------- */
function registerSW() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
})();

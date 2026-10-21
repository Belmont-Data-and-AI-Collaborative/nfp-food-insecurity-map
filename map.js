/* NFP Food Insecurity Map — main map logic
   Leaflet + marker clustering + NFP partners + Giving Matters + tract/ZIP layers.

   Configuration (indicator list, partner types, palettes) is loaded at startup
   from data/config.json, which the pipeline emits from project.yml via
   pipeline/export_config.py. Do not edit the constants below — edit project.yml
   and re-run `python -m pipeline --step export`. */

// Populated from data/config.json in applyConfig() before any rendering.
let PARTNER_TYPES = {};
let INDICATORS = [];
let PALETTES = {};
let PALETTE_META = [];

// Units derived from format strings, used in the indicator list row.
const UNIT_FROM_FMT = (s) => {
  if (!s) return "";
  if (s.includes("$")) return "$";
  if (s.includes("%")) return "%";
  return "";
};

// Convert a Python-style format string from project.yml to a JS formatter.
//   "${:,.0f}" -> v => "$" + Math.round(v).toLocaleString()
//   "{:.1f}%"  -> v => v.toFixed(1) + "%"
//   "{:,.0f}"  -> v => Math.round(v).toLocaleString()
//   "{}"       -> v => String(v)
function makeFormatter(fmt) {
  if (!fmt) return v => String(v);
  const isDollar = fmt.startsWith("$");
  const isPercent = fmt.endsWith("%");
  const m = fmt.match(/\{:(,)?(?:\.(\d+))?([fd])\}/);
  if (!m) return v => (isDollar ? "$" : "") + String(v) + (isPercent ? "%" : "");
  const hasComma = !!m[1];
  const decimals = m[2] === undefined ? (m[3] === "d" ? 0 : 0) : parseInt(m[2]);
  return (v) => {
    if (v == null || isNaN(v)) return "—";
    let out;
    if (decimals === 0) {
      out = Math.round(v);
      out = hasComma ? out.toLocaleString() : String(out);
    } else {
      out = Number(v).toFixed(decimals);
      if (hasComma) {
        const [int, frac] = out.split(".");
        out = parseInt(int).toLocaleString() + (frac ? "." + frac : "");
      }
    }
    return (isDollar ? "$" : "") + out + (isPercent ? "%" : "");
  };
}

function applyConfig(cfg) {
  PARTNER_TYPES = cfg.partner_types || {};
  PALETTES = cfg.palettes || {};
  PALETTE_META = cfg.palette_meta || [];
  INDICATORS = (cfg.indicators || []).map(ind => ({
    ...ind,
    unit: UNIT_FROM_FMT(ind.fmt),
    fmt: makeFormatter(ind.fmt),
    // Categorical flag: explicit from pipeline, or inferred from palette name.
    categorical: !!ind.categorical || ind.palette === "categorical",
  }));
  // Unified filter set starts with every partner type visible.
  state.orgFilters = new Set(Object.keys(PARTNER_TYPES));
}

// ---------- State ----------
// Phones: the sidebar covers the map there (Map.html @media), so it starts closed and closes again
// after a search result is picked; the legend starts collapsed.
const IS_PHONE = window.matchMedia("(max-width: 760px)").matches;

const state = {
  geo: "tract",
  indicator: "lila_flag",
  // Populated from PARTNER_TYPES in applyConfig(); empty until config loads.
  orgFilters: new Set(),
  showPartners: true,
  showGivingMatters: true,
  palette: (typeof TWEAK_DEFAULTS !== "undefined" && TWEAK_DEFAULTS.palette) || "greens",
  density: (typeof TWEAK_DEFAULTS !== "undefined" && TWEAK_DEFAULTS.density) || "compact",
  panels: IS_PHONE ? "hide" : (typeof TWEAK_DEFAULTS !== "undefined" && TWEAK_DEFAULTS.panels) || "show",
  data: {
    tracts: null, zipcodes: null, counties: null,
    partners: null, givingMatters: null,
    acsTract: null, acsZip: null,
    healthTract: null, healthZip: null,
    lila: null,
    fsiTract: null
  }
};

// ---------- Utilities ----------
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const rec = {};
    headers.forEach((h, idx) => { rec[h] = parts[idx]; });
    // Normalize GEOID: ZIP CSVs have leading zeros like "00000037010"
    let gid = String(rec.GEOID || "").replace(/"/g, "");
    // Tract GEOIDs are 11 chars starting with state FIPS (e.g. "47037..."). ZIP CSVs have
    // GEOIDs padded with leading zeros like "00000037010" — strip to last 5 chars for ZIPs.
    if (gid.length > 5 && gid.startsWith("000000")) gid = gid.slice(-5);
    else if (gid.length > 5 && gid.length < 11) {
      // TN tract GEOIDs start with state FIPS 47; ZIP rows get trimmed to 5 chars.
      gid = gid.startsWith("47") ? gid.padStart(11, "0") : gid.slice(-5);
    }
    rec.GEOID = gid;
    rows[gid] = rec;
  }
  return rows;
}
function splitCsvLine(line) {
  const out = []; let cur = ""; let inq = false;
  for (const c of line) {
    if (c === '"') inq = !inq;
    else if (c === "," && !inq) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function hexToRgb(h) {
  const n = parseInt(h.replace("#",""), 16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}
function rgbToHex(r,g,b) {
  return "#" + [r,g,b].map(v => Math.round(v).toString(16).padStart(2,"0")).join("");
}
function interpPalette(palette, t) {
  t = Math.max(0, Math.min(1, t));
  const scaled = t * (palette.length - 1);
  const i0 = Math.floor(scaled);
  const i1 = Math.min(palette.length - 1, i0 + 1);
  const f = scaled - i0;
  const a = hexToRgb(palette[i0]);
  const b = hexToRgb(palette[i1]);
  return rgbToHex(a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f);
}

function geoidOf(f, kind) {
  const p = f.properties || {};
  if (kind === "tract") {
    let g = p.GEOID || p.GEO_ID || p.geoid || "";
    return String(g).padStart(11, "0");
  }
  if (kind === "zip") {
    let g = p.ZCTA5CE20 || p.ZCTA5CE10 || p.GEOID20 || p.GEOID || p.ZCTA || p.zip || "";
    g = String(g).replace(/"/g, "");
    if (g.length > 5) g = g.slice(-5);
    return g;
  }
  return null;
}

function rowForGeoid(src, geoid) {
  if (!src) return null;
  const g = String(geoid);
  return src[g] || src[g.padStart(11, "0")] || null;
}

function valueFor(geoid, indicatorId) {
  const ind = INDICATORS.find(i => i.id === indicatorId);
  if (!ind) return null;
  let src = null;
  if (ind.src === "acs")    src = state.geo === "tract" ? state.data.acsTract : state.data.acsZip;
  if (ind.src === "health") src = state.geo === "tract" ? state.data.healthTract : state.data.healthZip;
  if (ind.src === "lila")   src = state.data.lila;
  if (ind.src === "fsi")    src = state.data.fsiTract;
  if (!src) return null;
  const row = rowForGeoid(src, geoid);
  if (!row) return null;
  const raw = row[ind.col];
  if (raw === "" || raw == null) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

function indicatorRange(indicatorId) {
  const ind = INDICATORS.find(i => i.id === indicatorId);
  if (!ind) return [0, 1];
  let src = null;
  if (ind.src === "acs")    src = state.geo === "tract" ? state.data.acsTract : state.data.acsZip;
  if (ind.src === "health") src = state.geo === "tract" ? state.data.healthTract : state.data.healthZip;
  if (ind.src === "lila")   src = state.data.lila;
  if (ind.src === "fsi")    src = state.data.fsiTract;
  if (!src) return [0, 1];
  let mn = Infinity, mx = -Infinity;
  for (const k in src) {
    const v = parseFloat(src[k][ind.col]);
    if (!isNaN(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  if (!isFinite(mn) || !isFinite(mx)) return [0, 1];
  return [mn, mx];
}

// ---------- Map ----------
let map, choroplethLayer, countyLayer, highlightLayer;
let hoveredLayer = null;
let nfpClusterLayer, gmClusterLayer;

function initMap() {
  map = L.map("map", {
    center: [36.05, -86.60],
    zoom: 9,
    minZoom: 7,
    maxZoom: 16,
    zoomControl: true,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
  });

  // CARTO needs a key since 2026 (keyless tiles come back watermarked "API KEY REQUIRED").
  // scripts/deploy.sh swaps the placeholder for the key in SSM /nfpmap/carto-basemap-key at deploy time,
  // so the key never sits in git; a local preview keeps the placeholder and shows the watermark.
  const CARTO_KEY = "__CARTO_BASEMAP_KEY__";
  const cartoKey = CARTO_KEY.startsWith("__") ? "" : `?key=${CARTO_KEY}`;
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${cartoKey}`, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  map.on("zoomend moveend", updateStatus);
}

function styleFeature(f) {
  const geoid = geoidOf(f, state.geo);
  const ind = INDICATORS.find(i => i.id === state.indicator);
  if (!ind || !geoid) {
    return { fillColor: "#f5f5f0", color: "#a4b0a4", weight: 0.5, fillOpacity: 0.1 };
  }
  if (ind.categorical) {
    const v = valueFor(geoid, state.indicator);
    const color = v == 1 ? "#a14b28" : "#e3efe4";
    return { fillColor: color, color: "#ffffff", weight: 0.6, fillOpacity: v == null ? 0.15 : 0.7 };
  }
  const v = valueFor(geoid, state.indicator);
  const [mn, mx] = indicatorRange(state.indicator);
  if (v == null) return { fillColor: "#efece6", color: "#d8d8d0", weight: 0.4, fillOpacity: 0.4 };
  const t = (v - mn) / (mx - mn || 1);
  const palette = PALETTES[state.palette];
  return {
    fillColor: interpPalette(palette, t),
    color: "#ffffff",
    weight: 0.5,
    fillOpacity: 0.78
  };
}

function drawChoropleth() {
  if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; }
  hoveredLayer = null;
  const src = state.geo === "tract" ? state.data.tracts : state.data.zipcodes;
  if (!src) return;
  choroplethLayer = L.geoJSON(src, {
    style: styleFeature,
    onEachFeature: (f, layer) => {
      layer.on("mouseover", () => {
        if (hoveredLayer && hoveredLayer !== highlightLayer) choroplethLayer.resetStyle(hoveredLayer);
        hoveredLayer = layer;
        layer.setStyle({ weight: 2, color: "#14391a" });
        layer.bringToFront();
      });
      layer.on("mouseout", () => {
        hoveredLayer = null;
        if (layer !== highlightLayer) choroplethLayer.resetStyle(layer);
      });
      layer.on("click", () => openFeatureDetail(f, layer));
    }
  }).addTo(map);
  if (countyLayer) countyLayer.bringToFront();
  if (nfpClusterLayer) nfpClusterLayer.bringToFront?.();
  if (gmClusterLayer) gmClusterLayer.bringToFront?.();
}

function drawCounties() {
  if (countyLayer) map.removeLayer(countyLayer);
  if (!state.data.counties) return;
  countyLayer = L.geoJSON(state.data.counties, {
    style: {
      fillOpacity: 0,
      color: "#14391a",
      weight: 1.2,
      dashArray: "3,4",
      opacity: 0.55
    },
    interactive: false
  }).addTo(map);
}

function makeClusterGroup(theme) {
  // theme: 'nfp' or 'gm'
  const fg = theme === "nfp" ? "#1b5e20" : "#a14b28";
  const bg = theme === "nfp" ? "#e3efe4" : "#fde4e0";
  return L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 40,
    disableClusteringAtZoom: 13,
    spiderfyDistanceMultiplier: 1.4,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: (cluster) => {
      const count = cluster.getChildCount();
      const size = count < 10 ? 32 : count < 50 ? 40 : count < 200 ? 48 : 56;
      return L.divIcon({
        html: `<div class="cluster-bubble" style="
          background:${bg};
          border:2px solid ${fg};
          color:${fg};
          width:${size}px;height:${size}px;line-height:${size-4}px;
          text-align:center;border-radius:50%;font-weight:600;
          font-family:Inter,sans-serif;font-size:${size<40?11:13}px;
          box-shadow:0 2px 6px rgba(20,57,26,0.18);
        ">${count}</div>`,
        className: "cluster-icon",
        iconSize: [size, size]
      });
    }
  });
}

function pointToMarker(f, theme) {
  const p = f.properties;
  const typeKey = p.partner_type || p.category || "other";
  const meta = PARTNER_TYPES[typeKey] || PARTNER_TYPES.other;
  const c = f.geometry.coordinates;
  const size = theme === "nfp" ? 18 : 12;
  const border = theme === "nfp" ? "2px solid white" : "1.5px solid white";
  const opacity = theme === "nfp" ? 1 : 0.85;
  const marker = L.marker([c[1], c[0]], {
    icon: L.divIcon({
      className: "",
      html: `<div class="pin" style="width:${size}px;height:${size}px;background:${meta.color};border:${border};opacity:${opacity};box-shadow:0 1px 3px rgba(0,0,0,0.4);border-radius:50%;"></div>`,
      iconSize: [size, size],
      iconAnchor: [size/2, size/2]
    })
  });
  const name = p.partner_name || p.name || "Organization";
  const affiliation = theme === "nfp" ? "TNFP Partner" : "Giving Matters";
  marker.bindPopup(`
    <div class="tt-title">${name}</div>
    <div style="font-size:0.78rem;color:var(--ink-500);margin-bottom:6px;">${p.address || ""}</div>
    <div class="tt-row"><span class="k">Category</span><span class="v" style="color:${meta.color}">${meta.label}</span></div>
    <div class="tt-row"><span class="k">Source</span><span class="v">${affiliation}</span></div>
  `);
  return marker;
}

function drawNfpPartners() {
  if (nfpClusterLayer) { map.removeLayer(nfpClusterLayer); nfpClusterLayer = null; }
  if (!state.showPartners || !state.data.partners) { updatePartnerCount(); return; }
  nfpClusterLayer = makeClusterGroup("nfp");
  const features = state.data.partners.features.filter(f =>
    state.orgFilters.has(f.properties.partner_type)
  );
  for (const f of features) nfpClusterLayer.addLayer(pointToMarker(f, "nfp"));
  map.addLayer(nfpClusterLayer);
  updatePartnerCount();
}

function drawGivingMatters() {
  if (gmClusterLayer) { map.removeLayer(gmClusterLayer); gmClusterLayer = null; }
  if (!state.showGivingMatters || !state.data.givingMatters) { updateGmCount(); return; }
  gmClusterLayer = makeClusterGroup("gm");
  const features = state.data.givingMatters.features.filter(f =>
    state.orgFilters.has(f.properties.partner_type || "other")
  );
  for (const f of features) gmClusterLayer.addLayer(pointToMarker(f, "gm"));
  map.addLayer(gmClusterLayer);
  updateGmCount();
}

// ---------- Detail panel ----------
function openFeatureDetail(f, layer) {
  const geoid = geoidOf(f, state.geo);
  const det = document.getElementById("detail");
  const title = document.getElementById("detail-title");
  const eyebrow = document.getElementById("detail-eyebrow");
  const body = document.getElementById("detail-body");

  if (state.geo === "tract") {
    const short = String(geoid).slice(-6);
    const county = tractCountyName(geoid);
    eyebrow.textContent = `Census Tract · ${county}`;
    title.textContent = `Tract ${short}`;
  } else {
    eyebrow.textContent = "ZIP Code · Nashville MSA";
    title.textContent = `ZIP ${geoid}`;
  }

  const income = valueFor(geoid, "median_household_income");
  const poverty = valueFor(geoid, "poverty_rate");
  const snap = valueFor(geoid, "snap_benefits");
  const pop = valueFor(geoid, "total_population");
  const diabetes = valueFor(geoid, "diabetes");
  const hypertension = valueFor(geoid, "hypertension");
  const obesity = valueFor(geoid, "obesity");
  const lila = state.geo === "tract" ? valueFor(geoid, "lila_flag") : null;
  const lapop = state.geo === "tract" ? valueFor(geoid, "lapop1") : null;
  const fiRate = state.geo === "tract" ? valueFor(geoid, "food_insecurity_rate") : null;

  const statGrid = `
    <div class="stat-grid">
      <div class="stat-box"><div class="k">Population</div><div class="v">${pop != null ? Math.round(pop).toLocaleString() : "—"}</div><div class="sub">ACS 2020–24</div></div>
      <div class="stat-box"><div class="k">Median Income</div><div class="v">${income != null ? "$" + Math.round(income).toLocaleString() : "—"}</div><div class="sub">Household</div></div>
      <div class="stat-box"><div class="k">Poverty Rate</div><div class="v">${poverty != null ? poverty.toFixed(1) + "%" : "—"}</div><div class="sub">ACS</div></div>
      ${state.geo === "tract" ? `<div class="stat-box"><div class="k">Food Insecurity</div><div class="v">${fiRate != null ? fiRate.toFixed(1) + "%" : "—"}</div><div class="sub">Modeled · 2023</div></div>` : ""}
      ${state.geo === "tract" ? `<div class="stat-box"><div class="k">LILA</div><div class="v" style="color:${lila == 1 ? 'var(--accent-rust)' : 'var(--nfp-green-700)'}">${lila == 1 ? "Yes" : lila == 0 ? "No" : "—"}</div><div class="sub">USDA flag</div></div>` : `<div class="stat-box"><div class="k">Low-Access</div><div class="v">—</div><div class="sub">Tract-level only</div></div>`}
    </div>
  `;

  const economicSection = (snap != null) ? `
    <h4>Economic indicators</h4>
    <div class="bar"><span class="k">SNAP Benefits</span><div class="track"><div class="fill" style="width:${Math.min(100, snap)}%; background: var(--accent-purple, #744f93);"></div></div><span class="v">${snap.toFixed(1)}%</span></div>
  ` : "";

  const healthSection = (diabetes != null || hypertension != null || obesity != null) ? `
    <h4>Health indicators</h4>
    <div class="bar"><span class="k">Diabetes</span><div class="track"><div class="fill" style="width:${diabetes != null ? Math.min(100, diabetes*3) : 0}%; background: var(--nfp-green-600);"></div></div><span class="v">${diabetes != null ? diabetes.toFixed(1) + "%" : "—"}</span></div>
    <div class="bar"><span class="k">Hypertension</span><div class="track"><div class="fill" style="width:${hypertension != null ? Math.min(100, hypertension*1.5) : 0}%; background: var(--accent-rust);"></div></div><span class="v">${hypertension != null ? hypertension.toFixed(1) + "%" : "—"}</span></div>
    <div class="bar"><span class="k">Obesity</span><div class="track"><div class="fill" style="width:${obesity != null ? Math.min(100, obesity*1.5) : 0}%; background: var(--accent-amber);"></div></div><span class="v">${obesity != null ? obesity.toFixed(1) + "%" : "—"}</span></div>
  ` : "";

  const accessSection = (state.geo === "tract") ? `
    <h4>Food access & insecurity</h4>
    <div class="bar"><span class="k">Insecurity</span><div class="track"><div class="fill" style="width:${fiRate != null ? Math.min(100, fiRate) : 0}%; background: var(--accent-amber);"></div></div><span class="v">${fiRate != null ? fiRate.toFixed(1) + "%" : "—"}</span></div>
    ${lapop != null ? `<div class="bar"><span class="k">Low access</span><div class="track"><div class="fill" style="width:${Math.min(100, (lapop / indicatorRange('lapop1')[1])*100)}%; background: var(--nfp-green-700);"></div></div><span class="v">${Math.round(lapop).toLocaleString()}</span></div>` : ""}
    <div class="bar"><span class="k">LILA</span><div class="track"><div class="fill" style="width:${lila == 1 ? 100 : 0}%; background: ${lila == 1 ? 'var(--accent-rust)' : 'var(--nfp-green-700)'};"></div></div><span class="v">${lila == 1 ? "Yes" : lila == 0 ? "No" : "—"}</span></div>
  ` : "";

  const centroid = featureCentroid(f);
  const nearby = nearestPartners(centroid, 5);
  const partnersSection = nearby.length ? `
    <h4>Nearby TNFP partners</h4>
    <div class="partners-near">
      ${nearby.map(n => {
        const meta = PARTNER_TYPES[n.type] || PARTNER_TYPES.other;
        return `<div class="p" data-lng="${n.lng}" data-lat="${n.lat}">
          <div class="dot" style="background:${meta.color}"></div>
          <div class="n">${n.name}</div>
          <div class="d">${n.dist.toFixed(1)} mi</div>
        </div>`;
      }).join("")}
    </div>
  ` : `<h4>Nearby TNFP partners</h4><div style="font-size:0.82rem;color:var(--ink-500);">No TNFP partners within 15 miles — candidate underserved area.</div>`;

  body.innerHTML = statGrid + economicSection + healthSection + accessSection + partnersSection +
    `<h4>Identifier</h4><div class="mono" style="color:var(--ink-600);">${geoid}</div>`;

  body.querySelectorAll(".partners-near .p").forEach(el => {
    el.addEventListener("click", () => {
      map.flyTo([parseFloat(el.dataset.lat), parseFloat(el.dataset.lng)], 14, { duration: 0.6 });
    });
  });

  det.classList.add("open");

  if (highlightLayer && highlightLayer !== layer && choroplethLayer) {
    try { choroplethLayer.resetStyle(highlightLayer); } catch(e) {}
  }
  highlightLayer = layer;
  layer.setStyle({ weight: 2.5, color: "#14391a" });
  layer.bringToFront();
}

function tractCountyName(geoid) {
  const counties = {
    "47015": "Cannon", "47021": "Cheatham", "47037": "Davidson", "47043": "Dickson",
    "47081": "Hickman", "47111": "Macon", "47119": "Maury", "47147": "Robertson",
    "47149": "Rutherford", "47159": "Smith", "47165": "Sumner", "47169": "Trousdale",
    "47187": "Williamson", "47189": "Wilson"
  };
  const prefix = String(geoid).slice(0, 5);
  return counties[prefix] ? counties[prefix] + " County" : "Nashville MSA";
}

function featureCentroid(f) {
  const g = f.geometry;
  if (!g) return null;
  const pts = [];
  function walk(coords) {
    if (typeof coords[0] === "number") pts.push(coords);
    else coords.forEach(walk);
  }
  walk(g.coordinates);
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p[0]; sy += p[1]; }
  return [sx / pts.length, sy / pts.length];
}

function nearestPartners(centroid, n) {
  if (!centroid || !state.data.partners) return [];
  const results = state.data.partners.features.map(f => {
    const c = f.geometry.coordinates;
    const dx = (c[0] - centroid[0]) * 55;
    const dy = (c[1] - centroid[1]) * 69;
    const dist = Math.sqrt(dx*dx + dy*dy);
    return {
      name: f.properties.partner_name,
      type: f.properties.partner_type,
      lng: c[0], lat: c[1], dist
    };
  });
  results.sort((a,b) => a.dist - b.dist);
  return results.slice(0, n).filter(r => r.dist < 15);
}

// ---------- Sidebar ----------
function renderIndicatorList() {
  const el = document.getElementById("indicator-list");
  const available = INDICATORS.filter(i => i.granularities.includes(state.geo));
  const unavailable = INDICATORS.filter(i => !i.granularities.includes(state.geo));
  document.getElementById("layer-count").textContent = `${available.length} available`;

  const noneRow = `<div class="row ${state.indicator == null ? 'on' : ''}" data-id="__none__">
    <div class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m5 5 14 14"/></svg></div>
    <div class="lbl">No layer (basemap only)</div>
  </div>`;

  el.innerHTML = noneRow + available.map(ind => `
    <div class="row ${state.indicator === ind.id ? 'on' : ''}" data-id="${ind.id}">
      <div class="ico">${indicatorIcon(ind.id)}</div>
      <div class="lbl">${ind.label}${(ind.src === "lila" || ind.src === "fsi") ? `<span title="${ind.caption}" style="font-size:0.7rem;color:var(--ink-400);cursor:help;margin-left:2px;">ⓘ</span>` : ""}</div>
      <div class="unit">${ind.unit}</div>
      <div class="year">${ind.data_year || ""}</div>
    </div>
  `).join("") + (unavailable.length ? `
    <div style="font-size:0.76rem;color:var(--ink-500);margin-top:8px;padding:0 8px;line-height:1.5;">
      Tract-only: ${unavailable.map(u => u.label).join(", ")}
    </div>
  ` : "");

  el.querySelectorAll(".row").forEach(r => {
    r.addEventListener("click", () => {
      const id = r.dataset.id;
      state.indicator = id === "__none__" ? null : id;
      const ind = INDICATORS.find(i => i.id === state.indicator);
      if (ind && !ind.categorical) state.palette = ind.palette;
      renderIndicatorList();
      drawChoropleth();
      updateLegend();
      updateBreadcrumb();
      renderPalettes();
    });
  });
}

function indicatorIcon(id) {
  const base = (p) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${p}</svg>`;
  return {
    median_household_income: base(`<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`),
    poverty_rate:            base(`<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>`),
    total_population:        base(`<circle cx="9" cy="10" r="3"/><circle cx="17" cy="10" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M15 20c0-2 2-4 5-4s4 2 4 4"/>`),
    diabetes:                base(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
    hypertension:            base(`<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>`),
    obesity:                 base(`<circle cx="12" cy="8" r="4"/><path d="M5 21c0-4 3-7 7-7s7 3 7 7"/>`),
    lila_flag:               base(`<path d="M3 3h18v18H3zM9 3v18M15 3v18"/>`),
    lapop1:                  base(`<circle cx="9" cy="10" r="3"/><circle cx="17" cy="14" r="2"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/>`),
    lalowi1:                 base(`<path d="M4 20V10M10 20V4M16 20v-8M22 20V14"/>`)
  }[id] || base(`<circle cx="12" cy="12" r="8"/>`);
}

function renderOrgList() {
  const el = document.getElementById("org-list");
  if (!el) return;
  const nfpCounts = {};
  const gmCounts = {};
  if (state.data.partners) {
    for (const f of state.data.partners.features) {
      const k = f.properties.partner_type || "other";
      nfpCounts[k] = (nfpCounts[k] || 0) + 1;
    }
  }
  if (state.data.givingMatters) {
    for (const f of state.data.givingMatters.features) {
      const k = f.properties.partner_type || "other";
      gmCounts[k] = (gmCounts[k] || 0) + 1;
    }
  }
  el.innerHTML = Object.entries(PARTNER_TYPES).map(([id, meta]) => {
    const n = (nfpCounts[id] || 0);
    const g = (gmCounts[id] || 0);
    return `
      <label class="row">
        <input type="checkbox" data-id="${id}" ${state.orgFilters.has(id) ? "checked" : ""}/>
        <span class="dot" style="background:${meta.color}"></span>
        <span class="lbl">${meta.label}</span>
        <span class="n" title="${n} TNFP · ${g} Giving Matters">${(n + g).toLocaleString()}${n ? ` <span style="color:var(--nfp-green-700);font-weight:600">·${n}</span>` : ""}</span>
      </label>
    `;
  }).join("");
  el.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("change", () => {
      if (inp.checked) state.orgFilters.add(inp.dataset.id);
      else state.orgFilters.delete(inp.dataset.id);
      drawNfpPartners();
      drawGivingMatters();
    });
  });
  updatePartnerCount();
  updateGmCount();
}

function updatePartnerCount() {
  const total = state.data.partners ? state.data.partners.features.length : 0;
  const visible = (state.showPartners && state.data.partners)
    ? state.data.partners.features.filter(f => state.orgFilters.has(f.properties.partner_type)).length
    : 0;
  const el = document.getElementById("nfp-count");
  if (el) el.textContent = `${visible}/${total} TNFP`;
}

function updateGmCount() {
  const total = state.data.givingMatters ? state.data.givingMatters.features.length : 0;
  const visible = (state.showGivingMatters && state.data.givingMatters)
    ? state.data.givingMatters.features.filter(f => state.orgFilters.has(f.properties.partner_type || "other")).length
    : 0;
  const el = document.getElementById("gm-count");
  if (el) el.textContent = `${visible.toLocaleString()}/${total.toLocaleString()} GM`;
}

// ---------- Legend ----------
function updateLegend() {
  const legend = document.getElementById("legend");
  if (!state.indicator) { legend.style.display = "none"; return; }
  legend.style.display = "block";
  const ind = INDICATORS.find(i => i.id === state.indicator);

  document.getElementById("legend-eyebrow").textContent =
    ind.src === "acs" ? "Census ACS" : ind.src === "health" ? "CDC PLACES" : "USDA LILA";
  document.getElementById("legend-name").textContent = ind.label;
  document.getElementById("legend-caption").textContent = ind.caption;

  const scaleWrap = document.getElementById("legend-scale-wrap");
  if (ind.categorical) {
    scaleWrap.innerHTML = `
      <div class="swatches">
        <div class="sw"><div class="b" style="background:#a14b28;"></div>LILA Tract</div>
        <div class="sw"><div class="b" style="background:#e3efe4;"></div>Not LILA</div>
      </div>
    `;
    return;
  }
  const palette = PALETTES[state.palette];
  const [mn, mx] = indicatorRange(state.indicator);
  scaleWrap.innerHTML = `
    <div class="scale" style="background: linear-gradient(to right, ${palette.join(", ")});"></div>
    <div class="ticks">
      <span>${ind.fmt(mn)}</span>
      <span>${ind.fmt((mn+mx)/2)}</span>
      <span>${ind.fmt(mx)}</span>
    </div>
  `;
}

// ---------- Search ----------
function setupSearch() {
  const inp = document.getElementById("search-input");
  const list = document.getElementById("search-results");

  inp.addEventListener("input", () => {
    const q = inp.value.trim().toLowerCase();
    if (!q || q.length < 2) { list.classList.remove("open"); list.innerHTML = ""; return; }
    const results = [];
    if (state.data.partners) {
      for (const f of state.data.partners.features) {
        const p = f.properties;
        if ((p.partner_name || "").toLowerCase().includes(q) || (p.address || "").toLowerCase().includes(q)) {
          results.push({ kind: "TNFP", title: p.partner_name, sub: p.address, type: "partner", coords: f.geometry.coordinates });
          if (results.length >= 6) break;
        }
      }
    }
    if (results.length < 8 && state.data.givingMatters) {
      for (const f of state.data.givingMatters.features) {
        const p = f.properties;
        const name = p.partner_name || "";
        if (name.toLowerCase().includes(q) || (p.address || "").toLowerCase().includes(q)) {
          results.push({ kind: "Org", title: name, sub: p.address, type: "org", coords: f.geometry.coordinates });
          if (results.length >= 10) break;
        }
      }
    }
    if (results.length < 10 && state.data.tracts) {
      for (const f of state.data.tracts.features) {
        const gid = geoidOf(f, "tract");
        if (String(gid).includes(q)) {
          results.push({ kind: "Tract", title: `Tract ${String(gid).slice(-6)}`, sub: tractCountyName(gid), type: "tract", feature: f });
          if (results.length >= 12) break;
        }
      }
    }
    if (results.length < 12 && state.data.zipcodes) {
      for (const f of state.data.zipcodes.features) {
        const gid = geoidOf(f, "zip");
        if (String(gid).includes(q)) {
          results.push({ kind: "ZIP", title: `ZIP ${gid}`, sub: "Nashville MSA", type: "zip", feature: f });
          if (results.length >= 14) break;
        }
      }
    }
    list.innerHTML = results.length ? results.map((r, i) => `
      <div class="item" data-i="${i}">
        <div><span class="kind">${r.kind}</span><span class="t">${r.title}</span></div>
        <div class="s">${r.sub || ""}</div>
      </div>
    `).join("") : `<div class="item" style="color:var(--ink-500);">No matches for "${q}"</div>`;
    list.classList.add("open");

    list.querySelectorAll(".item[data-i]").forEach(el => {
      el.addEventListener("click", () => {
        const r = results[parseInt(el.dataset.i)];
        if (IS_PHONE) applyPanels("hide");
        if (r.coords) {
          map.flyTo([r.coords[1], r.coords[0]], 14, { duration: 0.6 });
        } else {
          const c = featureCentroid(r.feature);
          if (c) map.flyTo([c[1], c[0]], 12, { duration: 0.6 });
          setTimeout(() => {
            if (choroplethLayer) {
              choroplethLayer.eachLayer(l => {
                if (geoidOf(l.feature, state.geo) === geoidOf(r.feature, state.geo)) {
                  openFeatureDetail(l.feature, l);
                }
              });
            }
          }, 400);
        }
        list.classList.remove("open");
        inp.value = r.title;
      });
    });
  });

  inp.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 150));
  inp.addEventListener("focus", () => { if (inp.value) list.classList.add("open"); });
}

// ---------- Status & breadcrumb ----------
function updateStatus() {
  const z = map.getZoom();
  document.getElementById("sb-zoom").textContent = "z" + z;
  document.getElementById("sb-geo").textContent = state.geo === "tract" ? "census tracts" : "zip codes";
  let visible = 0;
  if (nfpClusterLayer) {
    nfpClusterLayer.eachLayer(l => { if (l.getLatLng && map.getBounds().contains(l.getLatLng())) visible++; });
  }
  document.getElementById("sb-visible").textContent = `${visible} partners visible`;
}

function updateBreadcrumb() {
  const geoLabel = state.geo === "tract" ? "Census Tracts" : "ZIP Codes";
  const ind = INDICATORS.find(i => i.id === state.indicator);
  const indLabel = ind ? ind.label : "No layer";
  document.getElementById("breadcrumb").textContent = `Nashville MSA · ${geoLabel} · ${indLabel}`;
}

// ---------- Tweaks ----------
function renderPalettes() {
  const wrap = document.getElementById("palette-swatches");
  if (!wrap) return;
  wrap.innerHTML = PALETTE_META.map(p => `
    <div class="swatch ${p.id === state.palette ? 'on' : ''}" data-p="${p.id}" title="${p.label}">
      <div class="swatch-bar" style="background: linear-gradient(to right, ${PALETTES[p.id].join(", ")})"></div>
    </div>
  `).join("");
  wrap.querySelectorAll(".swatch").forEach(s => {
    s.addEventListener("click", () => {
      state.palette = s.dataset.p;
      renderPalettes();
      drawChoropleth();
      updateLegend();
      persistTweaks({ palette: state.palette });
    });
  });
}

function applyDensity(v) {
  state.density = v;
  document.body.setAttribute("data-density", v);
  document.querySelectorAll("#density-toggle button").forEach(b => b.classList.toggle("on", b.dataset.density === v));
  persistTweaks({ density: v });
}

function applyPanels(v) {
  state.panels = v;
  document.getElementById("sidebar").classList.toggle("collapsed", v === "hide");
  document.getElementById("panel-toggle-label").textContent = v === "hide" ? "Show panel" : "Hide panel";
  document.querySelectorAll("#panels-toggle button").forEach(b => b.classList.toggle("on", b.dataset.panels === v));
  setTimeout(() => map.invalidateSize(), 320);
  persistTweaks({ panels: v });
}

function persistTweaks(edits) {
  try { window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*"); } catch (e) {}
}

function setupTweaks() {
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "__activate_edit_mode") document.getElementById("tweaks-panel").classList.add("open");
    if (d.type === "__deactivate_edit_mode") document.getElementById("tweaks-panel").classList.remove("open");
  });
  try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch(e) {}

  document.getElementById("tweaks-toggle").addEventListener("click", () => {
    document.getElementById("tweaks-panel").classList.toggle("open");
  });

  document.querySelectorAll("#density-toggle button").forEach(b => {
    b.addEventListener("click", () => applyDensity(b.dataset.density));
  });
  document.querySelectorAll("#panels-toggle button").forEach(b => {
    b.addEventListener("click", () => applyPanels(b.dataset.panels));
  });

  applyDensity(state.density);
  applyPanels(state.panels);
  renderPalettes();
}

// ---------- Export ----------
function setupExport() {
  document.querySelectorAll("[data-export]").forEach(b => {
    b.addEventListener("click", () => {
      const kind = b.dataset.export;
      if (kind === "csv") exportCsv();
      else window.print();
    });
  });
}

function exportCsv() {
  const src = state.geo === "tract" ? state.data.tracts : state.data.zipcodes;
  if (!src) return;
  const rows = [["geoid", "region", "population", "median_income", "poverty_rate", "diabetes", "hypertension", "obesity", "lila", "low_access_pop"]];
  for (const f of src.features) {
    const gid = geoidOf(f, state.geo);
    rows.push([
      gid,
      state.geo === "tract" ? tractCountyName(gid) : "ZIP",
      valueFor(gid, "total_population") ?? "",
      valueFor(gid, "median_household_income") ?? "",
      valueFor(gid, "poverty_rate") ?? "",
      valueFor(gid, "diabetes") ?? "",
      valueFor(gid, "hypertension") ?? "",
      valueFor(gid, "obesity") ?? "",
      state.geo === "tract" ? (valueFor(gid, "lila_flag") ?? "") : "",
      state.geo === "tract" ? (valueFor(gid, "lapop1") ?? "") : ""
    ]);
  }
  const blob = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nfp_map_${state.geo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Data loading ----------
// Convert MultiLineString ZIP outlines into MultiPolygon features so they can be filled.
function polygonizeZipcodes(fc) {
  if (!fc || !fc.features) return fc;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "MultiLineString") {
      // Each line segment in the ZIP data is a tiny 2-pt edge. Chain them into rings.
      const segs = g.coordinates.map(s => s.slice());
      const rings = chainSegments(segs);
      if (rings.length === 1) {
        g.type = "Polygon";
        g.coordinates = [rings[0]];
      } else if (rings.length > 1) {
        g.type = "MultiPolygon";
        g.coordinates = rings.map(r => [r]);
      }
    } else if (g.type === "LineString") {
      g.type = "Polygon";
      g.coordinates = [g.coordinates.slice()];
    }
  }
  return fc;
}

function chainSegments(segs) {
  const EPS = 1e-6;
  const eq = (a, b) => Math.abs(a[0]-b[0]) < EPS && Math.abs(a[1]-b[1]) < EPS;
  const remaining = segs.map(s => s.slice());
  const rings = [];
  while (remaining.length) {
    let ring = remaining.shift().slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const start = s[0], end = s[s.length-1];
        const rStart = ring[0], rEnd = ring[ring.length-1];
        if (eq(rEnd, start)) { ring = ring.concat(s.slice(1)); remaining.splice(i,1); grew = true; break; }
        if (eq(rEnd, end))   { ring = ring.concat(s.slice(0,-1).reverse()); remaining.splice(i,1); grew = true; break; }
        if (eq(rStart, end))  { ring = s.slice(0,-1).concat(ring); remaining.splice(i,1); grew = true; break; }
        if (eq(rStart, start)){ ring = s.slice(1).reverse().concat(ring); remaining.splice(i,1); grew = true; break; }
      }
    }
    if (ring.length >= 3) {
      if (!eq(ring[0], ring[ring.length-1])) ring.push(ring[0].slice());
      rings.push(ring);
    }
  }
  return rings;
}

async function loadAll() {
  // Load frontend config first — every indicator/palette/partner-type the
  // rest of the code iterates over comes from this file.
  const cfg = await fetch("data/config.json")
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`data/config.json HTTP ${r.status}`)));
  applyConfig(cfg);

  const [tracts, zipcodes, counties, partners, givingMatters, acsTract, acsZip, healthTract, healthZip, lila, fsiTract] = await Promise.all([
    fetch("data/tracts.geojson").then(r => r.json()).catch(() => null),
    fetch("data/zipcodes.geojson").then(r => r.json()).catch(() => null),
    fetch("data/counties.geojson").then(r => r.json()).catch(() => null),
    fetch("data/partners.geojson").then(r => r.json()).catch(() => null),
    fetch("data/giving_matters.geojson").then(r => r.json()).catch(() => null),
    fetch("data/acs_tract.csv").then(r => r.text()).then(parseCsv).catch(() => ({})),
    fetch("data/acs_zip.csv").then(r => r.text()).then(parseCsv).catch(() => ({})),
    fetch("data/health_tract.csv").then(r => r.text()).then(parseCsv).catch(() => ({})),
    fetch("data/health_zip.csv").then(r => r.text()).then(parseCsv).catch(() => ({})),
    fetch("data/usda_lila_tract.csv").then(r => r.text()).then(parseCsv).catch(() => ({})),
    fetch("data/food_insecurity_tract.csv").then(r => r.text()).then(parseCsv).catch(() => ({}))
  ]);
  if (tracts) tracts.features.forEach(f => {
    const g = String(geoidOf(f, "tract") || "");
    f.properties.GEOID = g.padStart(11, "0");
  });
  if (zipcodes) polygonizeZipcodes(zipcodes);
  state.data = { tracts, zipcodes, counties, partners, givingMatters, acsTract, acsZip, healthTract, healthZip, lila, fsiTract };
}

// ---------- Init ----------
async function init() {
  initMap();
  await loadAll();

  // If the configured default indicator was removed from project.yml,
  // fall back to the first one that's actually available at this granularity.
  if (!INDICATORS.find(i => i.id === state.indicator)) {
    const firstAvailable = INDICATORS.find(i => i.granularities.includes(state.geo));
    state.indicator = firstAvailable ? firstAvailable.id : null;
  }

  drawCounties();
  drawChoropleth();
  drawNfpPartners();
  drawGivingMatters();

  renderIndicatorList();
  renderOrgList();
  updateLegend();
  updateBreadcrumb();
  updateStatus();

  // Geo toggle
  document.querySelectorAll("#geo-toggle button").forEach(b => {
    b.addEventListener("click", () => {
      state.geo = b.dataset.geo;
      document.querySelectorAll("#geo-toggle button").forEach(x => x.classList.toggle("on", x === b));
      const ind = INDICATORS.find(i => i.id === state.indicator);
      if (ind && !ind.granularities.includes(state.geo)) {
        console.warn(`Indicator "${state.indicator}" unavailable for geo "${state.geo}"; switching to median_household_income`);
        state.indicator = "median_household_income";
      }
      drawChoropleth();
      renderIndicatorList();
      updateLegend();
      updateBreadcrumb();
      updateStatus();
    });
  });

  // Source toggles: NFP partners / Giving Matters
  document.querySelectorAll("[data-src-toggle]").forEach(label => {
    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      const which = label.dataset.srcToggle;
      if (which === "nfp") state.showPartners = input.checked;
      if (which === "gm") state.showGivingMatters = input.checked;
      label.classList.toggle("on", input.checked);
      if (which === "nfp") drawNfpPartners();
      if (which === "gm") drawGivingMatters();
    });
  });

  // Panel hide (floating)
  document.getElementById("panel-toggle").addEventListener("click", () => {
    applyPanels(state.panels === "hide" ? "show" : "hide");
  });

  if (IS_PHONE) {
    document.getElementById("legend").classList.remove("expanded");
    document.getElementById("legend-toggle").title = "Expand legend";
  }
  document.getElementById("legend-toggle").addEventListener("click", () => {
    const legend = document.getElementById("legend");
    const expanded = legend.classList.toggle("expanded");
    document.getElementById("legend-toggle").title = expanded ? "Collapse legend" : "Expand legend";
  });

  document.getElementById("detail-close").addEventListener("click", () => {
    document.getElementById("detail").classList.remove("open");
    if (highlightLayer && choroplethLayer) { try { choroplethLayer.resetStyle(highlightLayer); } catch(e) {} highlightLayer = null; }
  });

  setupSearch();
  setupTweaks();
  setupExport();

  document.getElementById("loading").style.display = "none";
}

document.addEventListener("DOMContentLoaded", init);

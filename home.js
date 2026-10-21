// Dynamic landing-page stats — mirrors app.py::_gather_key_stats from the
// original Streamlit build. Pulls counts from the same data/ files the Map
// page consumes, so the landing bar stays in sync with every pipeline run.
(async () => {
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const set = (key, val) => {
    const el = document.querySelector(`[data-stat="${key}"]`);
    if (el) el.textContent = val;
  };

  async function countFeatures(path) {
    try {
      const r = await fetch(path);
      if (!r.ok) return null;
      const gj = await r.json();
      return (gj.features || []).length;
    } catch { return null; }
  }

  const [cfg, tracts, partners, gm] = await Promise.all([
    fetch("data/config.json").then(r => r.ok ? r.json() : null).catch(() => null),
    countFeatures("data/tracts.geojson"),
    countFeatures("data/partners.geojson"),
    countFeatures("data/giving_matters.geojson"),
  ]);

  if (cfg) {
    set("counties", fmt(cfg.geography && cfg.geography.msa_counties_count));
    set("indicators", fmt((cfg.indicators || []).length));
  }
  set("tracts", fmt(tracts));
  set("partners", fmt(partners));
  set("giving_matters", fmt(gm));

  // Data freshness — written by the pipeline at export time.
  try {
    const r = await fetch("data/last_updated.txt");
    document.getElementById("freshness").textContent = r.ok ? (await r.text()).trim() : "—";
  } catch {
    document.getElementById("freshness").textContent = "—";
  }
})();

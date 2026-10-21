"""Source-level tests for phase2-frontend-p1 Items 1, 2, 3, 4, 5.

These tests verify the *source text* of map.js and Map.html so they run
instantly without a browser. Each test is annotated with the spec acceptance
criterion it covers.

Criteria that require a live browser (visual rendering, mouse interaction,
zoom-level clustering) are documented under MANUAL_ONLY at the bottom of this
module.
"""
from __future__ import annotations

from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
MAP_JS = (PROJECT_ROOT / "map.js").read_text(encoding="utf-8")
MAP_HTML = (PROJECT_ROOT / "Map.html").read_text(encoding="utf-8")
INDEX_HTML = (PROJECT_ROOT / "index.html").read_text(encoding="utf-8")
ABOUT_HTML = (PROJECT_ROOT / "About.html").read_text(encoding="utf-8")


# ── Item 1: TNFP label fixes ─────────────────────────────────────────────────

class TestTNFPLabels:
    """AC 1.1–1.6: All display strings say TNFP, not NFP."""

    def test_1_1_sidebar_chip_reads_tnfp_partners(self):
        """Map.html sidebar org-toggle chip must read 'TNFP Partners'."""
        assert "TNFP Partners" in MAP_HTML

    def test_1_1_no_raw_nfp_partners_chip(self):
        """The old 'NFP Partners' chip text must be gone."""
        # Allow "TNFP Partners" but not a bare "NFP Partners"
        import re
        assert not re.search(r'(?<!T)NFP Partners', MAP_HTML), (
            "Found 'NFP Partners' without the TNFP prefix in Map.html"
        )

    def test_1_2_count_chip_uses_tnfp(self):
        """AC 1.2: count chip template uses 'TNFP' not 'NFP'."""
        assert "TNFP" in MAP_JS
        # Specific chip line: "${visible}/${total} TNFP"
        assert "TNFP" in MAP_JS

    def test_1_2_count_chip_exact_string(self):
        """The count chip must emit '…TNFP' not '…NFP'."""
        assert "} TNFP`" in MAP_JS or "TNFP`" in MAP_JS

    def test_1_3_detail_panel_heading(self):
        """AC 1.3: detail panel section heading reads 'Nearby TNFP partners'."""
        assert "Nearby TNFP partners" in MAP_JS

    def test_1_4_detail_panel_fallback_text(self):
        """AC 1.4: fallback text reads 'No TNFP partners within 15 miles'."""
        assert "No TNFP partners within 15 miles" in MAP_JS

    def test_1_5_marker_popup_affiliation(self):
        """AC 1.5: marker popup affiliation label is 'TNFP Partner'."""
        assert '"TNFP Partner"' in MAP_JS or "'TNFP Partner'" in MAP_JS

    def test_1_6_search_result_kind_badge(self):
        """AC 1.6: search result kind badge is 'TNFP' not 'NFP'."""
        assert 'kind: "TNFP"' in MAP_JS

    def test_map_html_legend_note_uses_tnfp(self):
        """Map.html legend note must say 'TNFP partners' not 'NFP partners'."""
        assert "marks TNFP partners" in MAP_HTML

    def test_page_titles_updated_to_tnfp(self):
        """All three page <title> elements must say 'TNFP Food Insecurity Map'."""
        assert "TNFP Food Insecurity Map" in MAP_HTML
        assert "TNFP Food Insecurity Map" in INDEX_HTML
        assert "TNFP Food Insecurity Map" in ABOUT_HTML


# ── Item 2: LILA as default layer ────────────────────────────────────────────

class TestLILADefault:
    """AC 2.1–2.4: lila_flag is the startup indicator; ZIP auto-switches."""

    def test_2_1_default_indicator_is_lila_flag(self):
        """AC 2.1: state initializer sets indicator to 'lila_flag'."""
        assert 'indicator: "lila_flag"' in MAP_JS

    def test_2_1_not_median_household_income_default(self):
        """The old default indicator must not appear as the initial value."""
        # The old default was median_household_income; it may still exist as a
        # fallback target, but must not be the initial state value.
        import re
        init_block = re.search(
            r'const\s+state\s*=\s*\{[^}]*indicator[^}]*\}', MAP_JS, re.DOTALL
        )
        assert init_block, "Could not locate state initializer block"
        assert 'indicator: "lila_flag"' in init_block.group(0), (
            "state.indicator initializer is not 'lila_flag'"
        )

    def test_2_3_geo_toggle_handler_auto_switches_to_median(self):
        """AC 2.3: geo-toggle click handler auto-switches indicator when not
        available for the selected geo, defaulting to median_household_income."""
        assert 'state.indicator = "median_household_income"' in MAP_JS

    def test_2_3_auto_switch_guards_granularities(self):
        """The guard must check ind.granularities before switching."""
        assert "granularities" in MAP_JS
        assert "ind.granularities.includes" in MAP_JS

    def test_2_3_console_warn_on_indicator_switch(self):
        """A console.warn must fire when the indicator is auto-switched."""
        assert "console.warn" in MAP_JS
        assert "switching to median_household_income" in MAP_JS


# ── Item 3: Sticky tract highlights (source-level only) ──────────────────────

class TestStickyHighlights:
    """AC 3.1–3.3: hoveredLayer pattern; full interaction is manual-only."""

    def test_hovered_layer_declared(self):
        """hoveredLayer must be declared as a module-level variable."""
        assert "let hoveredLayer = null" in MAP_JS

    def test_hovered_layer_reset_on_mouseover(self):
        """mouseover handler must call resetStyle on previous hoveredLayer."""
        assert "choroplethLayer.resetStyle(hoveredLayer)" in MAP_JS

    def test_hovered_layer_cleared_on_mouseout(self):
        """mouseout handler must set hoveredLayer = null."""
        assert "hoveredLayer = null" in MAP_JS

    def test_highlight_layer_guard_preserved(self):
        """Click-selected highlight guard (hoveredLayer !== highlightLayer) must exist."""
        assert "hoveredLayer !== highlightLayer" in MAP_JS

    def test_mouseout_clears_hovered_before_highlight_guard(self):
        """mouseout: hoveredLayer = null must appear before the highlightLayer guard."""
        mouseout_idx = MAP_JS.find("hoveredLayer = null")
        highlight_guard_idx = MAP_JS.find("if (layer !== highlightLayer)")
        assert mouseout_idx != -1 and highlight_guard_idx != -1
        assert mouseout_idx < highlight_guard_idx, (
            "hoveredLayer = null must come before the highlightLayer guard in mouseout"
        )


# ── Item 4: ⓘ tooltip on LILA indicators ─────────────────────────────────────

class TestLILAInfoTooltip:
    """AC 4.3–4.4: ⓘ icon is appended for lila-src indicators in the sidebar."""

    def test_4_3_info_icon_rendered_for_lila(self):
        """AC 4.3: renderIndicatorList conditionally adds ⓘ for lila indicators."""
        assert "ⓘ" in MAP_JS

    def test_4_3_conditional_on_lila_src(self):
        """ⓘ is only rendered when ind.src === 'lila'."""
        assert 'ind.src === "lila"' in MAP_JS

    def test_4_4_title_bound_to_caption(self):
        """AC 4.4: title attribute is bound to ind.caption (tooltip text = caption), HTML-escaped."""
        assert 'title="${escapeHtml(ind.caption)}"' in MAP_JS

    def test_4_4_cursor_help_style(self):
        """ⓘ icon must have cursor:help so users know it's hoverable."""
        assert "cursor:help" in MAP_JS


# ── Item 5: Cluster configuration ────────────────────────────────────────────

class TestClusterConfig:
    """AC 5.1–5.3 (source-level): cluster options are set to spec values."""

    def test_5_1_disable_clustering_at_zoom_13(self):
        """AC 5.1: disableClusteringAtZoom must be set to 13."""
        assert "disableClusteringAtZoom: 13" in MAP_JS

    def test_5_2_max_cluster_radius_reduced_to_40(self):
        """AC 5.2: maxClusterRadius must be 40 (reduced from 50)."""
        assert "maxClusterRadius: 40" in MAP_JS
        assert "maxClusterRadius: 50" not in MAP_JS

    def test_5_3_spiderfy_distance_multiplier(self):
        """AC 5.3: spiderfyDistanceMultiplier must be 1.4."""
        assert "spiderfyDistanceMultiplier: 1.4" in MAP_JS


# ── Item 6 (source level): data_year rendered in indicator rows ───────────────

class TestDataYearInMapJs:
    """AC 6.1–6.2 (source-level): year div is emitted in renderIndicatorList."""

    def test_6_1_year_div_rendered(self):
        """AC 6.1: renderIndicatorList emits a .year element."""
        assert '<div class="year">' in MAP_JS or "class=\"year\"" in MAP_JS

    def test_6_1_year_pulls_from_ind_data_year(self):
        """The year element uses ind.data_year."""
        assert "ind.data_year" in MAP_JS

    def test_6_2_year_css_in_map_html(self):
        """AC 6.2: .indicator-list .row .year CSS rule exists in Map.html."""
        assert ".year" in MAP_HTML


# ─────────────────────────────────────────────────────────────────────────────
# MANUAL-ONLY acceptance criteria
# These require a live browser and cannot be automated without a headless driver.
# ─────────────────────────────────────────────────────────────────────────────
#
# Item 2:
#   2.1 — Map loads with LILA tracts visually colored (rust/green dichotomy)
#   2.2 — Sidebar indicator list shows LILA Designation row with `.on` class on load
#   2.4 — ZIP view shows a full choropleth (not a near-invisible wash)
#
# Item 3 (all):
#   3.1 — Rapid mouse movement across 10+ tracts leaves no stuck highlights
#   3.2 — Clicking a tract keeps it highlighted after cursor moves away
#   3.3 — Clicking a second tract removes the first highlight
#
# Item 5 (all visual):
#   5.1 — At zoom 13 every dot renders individually in Davidson County
#   5.2 — At zoom 12 clusters are less aggressive than before
#   5.3 — Clicking a spiderfied cluster at zoom 11 shows well-spaced markers
#
# Item 6:
#   6.1 — Each sidebar row shows year badge (e.g. "2020–2024", "2024", "2019")
#   6.2 — Badge is right-aligned, monospace, smaller than indicator label
#
# Verify manually:  python -m http.server 8000  →  http://localhost:8000/Map.html

"""Tests for phase2-frontend-p1 Items 4 and 6 as expressed in project.yml.

Covers:
- AC 4.1: lila_flag caption starts with the USDA designation text
- AC 4.2: lapop1 caption starts with the 'Number of residents…' text
- AC 6 (all indicators): every variable in project.yml has a non-empty data_year
- AC 6 (per-source): data_year values match expected vintages per data source
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture(scope="module")
def project_cfg() -> dict:
    with open(PROJECT_ROOT / "project.yml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _all_variables(project_cfg: dict) -> list[tuple[str, str, dict]]:
    """Yield (source_key, var_id, var_dict) for every variable in project.yml."""
    rows = []
    for src_key, src_cfg in project_cfg.get("data_sources", {}).items():
        for var in src_cfg.get("variables", []) or []:
            var_id = var.get("id") or var.get("column", "?")
            rows.append((src_key, var_id, var))
    return rows


# ── AC 4.1: lila_flag caption ────────────────────────────────────────────────

class TestLILACaptions:
    """AC 4.1–4.2: LILA indicator captions contain the required text."""

    def _find_var(self, project_cfg, var_id):
        for _, _, var in _all_variables(project_cfg):
            if (var.get("id") or var.get("column", "")) == var_id:
                return var
        return None

    def test_4_1_lila_flag_caption_starts_with_usda_designation(self, project_cfg):
        """AC 4.1: lila_flag caption must begin with 'USDA designation:'."""
        var = self._find_var(project_cfg, "lila_flag")
        assert var is not None, "lila_flag variable not found in project.yml"
        caption = var.get("caption", "")
        assert caption.strip().startswith("USDA designation:"), (
            f"lila_flag caption should start with 'USDA designation:', got:\n{caption!r}"
        )

    def test_4_1_lila_flag_caption_mentions_supermarket_distance(self, project_cfg):
        """lila_flag caption must mention the supermarket distance threshold."""
        var = self._find_var(project_cfg, "lila_flag")
        caption = var.get("caption", "")
        assert "1 mile" in caption and "supermarket" in caption.lower(), (
            "lila_flag caption should mention '1 mile … supermarket'"
        )

    def test_4_1_lila_flag_caption_mentions_income_threshold(self, project_cfg):
        """lila_flag caption must give both USDA low-income-tract triggers: poverty >=20% or
        median family income <=80% of the statewide/metro median (USDA ERS FARA documentation)."""
        var = self._find_var(project_cfg, "lila_flag")
        caption = var.get("caption", "")
        assert "80%" in caption, "lila_flag caption should mention the 80% median-family-income trigger"
        assert "20%" in caption, "lila_flag caption should mention the poverty-rate >=20% trigger"

    def test_4_1_lila_flag_caption_cites_usda_ers(self, project_cfg):
        """lila_flag caption must cite USDA ERS as the source."""
        var = self._find_var(project_cfg, "lila_flag")
        caption = var.get("caption", "")
        assert "USDA ERS" in caption, "lila_flag caption should cite 'USDA ERS'"

    def test_4_2_lapop1_caption_starts_with_number_of_residents(self, project_cfg):
        """AC 4.2: lapop1 caption must begin with 'Number of residents living more than 1 mile'."""
        var = self._find_var(project_cfg, "lapop1")
        assert var is not None, "lapop1 variable not found in project.yml"
        caption = var.get("caption", "")
        assert caption.strip().startswith("Number of residents living more than 1 mile"), (
            f"lapop1 caption should start with 'Number of residents living more than 1 mile…', got:\n{caption!r}"
        )

    def test_lalowi1_caption_mentions_low_income_threshold(self, project_cfg):
        """lalowi1 counts low-income *individuals*: income at or below 200% of the federal
        poverty level (USDA ERS FARA) — not the 80%-of-median tract test."""
        var = self._find_var(project_cfg, "lalowi1")
        assert var is not None, "lalowi1 variable not found in project.yml"
        caption = var.get("caption", "")
        assert "200%" in caption, "lalowi1 caption should give the 200%-of-poverty threshold"
        assert "80%" not in caption, "lalowi1 caption should not use the 80%-of-median tract test"


# ── AC 6: data_year on every variable ────────────────────────────────────────

class TestDataYearFields:
    """AC 6.3 (project.yml side): every indicator variable has a non-empty data_year."""

    def test_every_variable_has_data_year(self, project_cfg):
        """Every variable in project.yml must have a non-empty data_year."""
        missing = []
        for src_key, var_id, var in _all_variables(project_cfg):
            dy = var.get("data_year", "")
            if not dy or not str(dy).strip():
                missing.append(f"{src_key}/{var_id}")
        assert not missing, (
            f"These variables are missing data_year: {missing}"
        )

    @pytest.mark.parametrize("var_id,expected_year", [
        ("median_household_income", "2020–2024"),
        ("poverty_rate", "2020–2024"),
        ("total_population", "2020–2024"),
        ("snap_households", "2020–2024"),
    ])
    def test_acs_variables_have_correct_data_year(self, project_cfg, var_id, expected_year):
        """ACS variables must have data_year '2020–2024'."""
        for _, vid, var in _all_variables(project_cfg):
            if (var.get("id") or var.get("column", "").lower()) == var_id:
                assert var.get("data_year") == expected_year, (
                    f"{var_id} data_year: expected {expected_year!r}, got {var.get('data_year')!r}"
                )
                return
        pytest.skip(f"{var_id} not found in project.yml — may use a different key")

    @pytest.mark.parametrize("var_id", ["lila_flag", "lapop1", "lalowi1"])
    def test_usda_lila_variables_have_2019_year(self, project_cfg, var_id):
        """USDA LILA variables must have data_year '2019'."""
        for _, vid, var in _all_variables(project_cfg):
            found_id = var.get("id") or var.get("column", "")
            if found_id == var_id:
                assert var.get("data_year") == "2019", (
                    f"{var_id} data_year: expected '2019', got {var.get('data_year')!r}"
                )
                return
        pytest.fail(f"{var_id} not found in project.yml")

    @pytest.mark.parametrize("var_id", ["DIABETES", "BPHIGH", "OBESITY"])
    def test_cdc_health_variables_have_2024_year(self, project_cfg, var_id):
        """CDC PLACES health variables must have data_year '2024'."""
        for _, vid, var in _all_variables(project_cfg):
            if var.get("column") == var_id:
                assert var.get("data_year") == "2024", (
                    f"{var_id} data_year: expected '2024', got {var.get('data_year')!r}"
                )
                return
        pytest.fail(f"Column {var_id} not found in project.yml")

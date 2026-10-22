"""Shared constants for the debate-coach project.

Label order (WEAK=0, MODERATE=1, STRONG=2) matches ``dataset_config.json``
and the ``label_id`` column of the balanced CSVs, and mirrors the ordering
used in the original ``smart_predictor.py``.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
BALANCED_DIR = DATA_DIR / "debate_coach_data"
RAW_DIR = DATA_DIR / "debate_data"
MODELS_DIR = PROJECT_ROOT / "models"
REPORTS_DIR = PROJECT_ROOT / "reports"

TRAIN_CSV = BALANCED_DIR / "balanced_train.csv"
TEST_CSV = BALANCED_DIR / "balanced_test.csv"
T5_JSON = BALANCED_DIR / "t5_training_data.json"
DATASET_CONFIG = BALANCED_DIR / "dataset_config.json"

CLASSIFIER_BUNDLE = MODELS_DIR / "debate_coach_classifier.joblib"
METRICS_JSON = REPORTS_DIR / "metrics.json"
CONFUSION_CSV = REPORTS_DIR / "confusion_matrix.csv"

# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------
LABELS = ["weak", "moderate", "strong"]  # index == label_id
LABEL2ID = {label: i for i, label in enumerate(LABELS)}
ID2LABEL = {i: label for label, i in LABEL2ID.items()}
LABELS_UPPER = [label.upper() for label in LABELS]

# ---------------------------------------------------------------------------
# Coaching templates -- the exact 3 unique target strings from
# t5_training_data.json (verified: 8091 records, 3 unique targets,
# 2697 per class). The T5 task is therefore a deterministic
# classify -> render pipeline.
# ---------------------------------------------------------------------------
COACH_TEMPLATES = {
    "weak": (
        "Strength: WEAK. Argument lacks evidence, may contain logical "
        "fallacies. Add data and cite sources."
    ),
    "moderate": (
        "Strength: MODERATE. Reasonable position that could be "
        "strengthened with more specific evidence."
    ),
    "strong": (
        "Strength: STRONG. Well-structured argument with credible "
        "evidence and sound reasoning."
    ),
}

# Prompt prefix used by t5_training_data.json inputs.
T5_PROMPT_PREFIX = "Analyze argument strength: "

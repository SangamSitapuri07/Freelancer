"""Dataset loading and validation for the debate-coach project.

Canonical training/eval data is the *balanced* corpus produced by the
``debate_coach_data_pipeline`` notebook and stored in Google Drive:

- ``balanced_train.csv`` / ``balanced_test.csv``
  columns: ``text, label, source, full_output, fallacy_type, label_id``
- ``t5_training_data.json``
  seq2seq task with ``input_text`` / ``target_text`` pairs.

The raw ``debate_data/`` JSONL corpus (pre-balancing) is kept for
reference/auditing only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import pandas as pd

from .config import (
    DATASET_CONFIG,
    LABEL2ID,
    LABELS,
    T5_JSON,
    TEST_CSV,
    TRAIN_CSV,
)


@dataclass
class DatasetInfo:
    """Summary of the loaded corpus, printed in training reports."""

    n_train: int
    n_test: int
    train_distribution: Dict[str, int]
    test_distribution: Dict[str, int]
    sources: Dict[str, int] = field(default_factory=dict)
    t5_records: int = 0
    t5_unique_targets: int = 0


def load_balanced_csv(path: Path) -> pd.DataFrame:
    """Load one balanced split and normalise columns."""
    df = pd.read_csv(path)
    missing = {"text", "label"} - set(df.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {sorted(missing)}")
    df["text"] = df["text"].astype(str).fillna("")
    df["label"] = df["label"].str.lower().str.strip()
    bad = sorted(set(df["label"]) - set(LABELS))
    if bad:
        raise ValueError(f"{path} contains unknown labels: {bad}")
    if "label_id" not in df.columns:
        df["label_id"] = df["label"].map(LABEL2ID)
    return df


def load_splits(
    train_csv: Path = TRAIN_CSV, test_csv: Path = TEST_CSV
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Return (train, test) dataframes with ``text``, ``label``, ``label_id``."""
    if not train_csv.exists() or not test_csv.exists():
        raise FileNotFoundError(
            "Balanced dataset not found. Expected:\n"
            f"  {train_csv}\n  {test_csv}\n"
            "Copy the debate_coach_data/ folder from Google Drive into data/."
        )
    train = load_balanced_csv(train_csv)
    test = load_balanced_csv(test_csv)
    return train, test


def load_t5_pairs(path: Path = T5_JSON) -> List[Dict[str, str]]:
    """Load the seq2seq (input_text, target_text) pairs of the coach task."""
    if not path.exists():
        raise FileNotFoundError(f"T5 training data not found: {path}")
    with open(path) as fh:
        records = json.load(fh)
    for rec in records:
        if "input_text" not in rec or "target_text" not in rec:
            raise ValueError(f"{path}: record missing input_text/target_text")
    return records


def load_dataset_config(path: Path = DATASET_CONFIG) -> dict:
    if path.exists():
        with open(path) as fh:
            return json.load(fh)
    return {}


def describe(train: pd.DataFrame, test: pd.DataFrame) -> DatasetInfo:
    """Build a :class:`DatasetInfo` summary for reporting."""
    info = DatasetInfo(
        n_train=len(train),
        n_test=len(test),
        train_distribution=train["label"].value_counts().to_dict(),
        test_distribution=test["label"].value_counts().to_dict(),
    )
    if "source" in train.columns:
        info.sources = train["source"].value_counts().to_dict()
    if T5_JSON.exists():
        records = load_t5_pairs()
        info.t5_records = len(records)
        info.t5_unique_targets = len({r["target_text"] for r in records})
    return info


def xy(
    df: pd.DataFrame,
) -> Tuple[List[str], Sequence[int]]:
    """Split a dataframe into raw texts and integer labels."""
    return df["text"].tolist(), df["label_id"].astype(int).tolist()

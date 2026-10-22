"""Handcrafted linguistic features for argument-strength scoring.

These dense features are appended to the TF-IDF representation. They encode
the surface signals that distinguish weak / moderate / strong arguments in
this corpus: statistics and citations, hedging and anecdotal markers,
superlatives, first-person framing, and readability.

``textstat`` and ``wordfreq`` are optional; their columns degrade to neutral
values when the packages are unavailable so training always works.
"""

from __future__ import annotations

import re
from typing import List, Sequence

import numpy as np
from scipy import sparse

try:  # optional: readability formulas
    import textstat

    _HAS_TEXTSTAT = True
except Exception:  # pragma: no cover - environment dependent
    _HAS_TEXTSTAT = False

try:  # optional: Zipf word-frequency statistics
    from wordfreq import zipf_frequency

    _HAS_WORDFREQ = True
except Exception:  # pragma: no cover - environment dependent
    _HAS_WORDFREQ = False


# ---------------------------------------------------------------------------
# Marker lexicons (lowercase; matched as substrings or words as indicated)
# ---------------------------------------------------------------------------
_CITATION_MARKERS = [
    "according to", "et al", "study", "studies", "journal", "university",
    "researchers", "meta-analysis", "meta analysis", "survey", "professor",
    "scientists", "published", "report", "census", "world bank", "cdc",
    "who ", "nhs", "harvard", "oxford", "cambridge", "peer-review",
    "peer reviewed", "clinical trial", "experiment", "longitudinal",
    "randomized", "randomised", "control group", "sample of",
]

_STAT_MARKERS = [
    "data", "evidence", "percent", "percentage", "significant",
    "correlation", "causation", "statistic", "research", "found that",
    "showed that", "shows that", "demonstrates", "indicates", "suggests",
    "confirmed", "measured", "outcome", "results", "dataset", "analysis",
    "rates", "ratio", "average", "median", "population",
]

_HEDGE_MARKERS = [
    "maybe", "perhaps", "probably", "i think", "i believe", "i feel",
    "i guess", "might", "could be", "possibly", "somewhat", "kind of",
    "sort of", "in my opinion", "arguably", "more or less", "or something",
    "not sure", "seems like",
]

_ANECDOTE_MARKERS = [
    "my friend", "my uncle", "my aunt", "my cousin", "my neighbor",
    "my neighbour", "my brother", "my sister", "my mom", "my dad",
    "i heard", "someone told me", "everyone knows", "they say that",
    "people say", "i saw on", "i read online", "youtube", "facebook",
    "tiktok", "twitter", "instagram", "a blog", "some guy", "this guy",
    "trust me", "believe me",
]

_SUPERLATIVE_MARKERS = [
    "always", "never", "everyone", "nobody", "no one", "every single",
    "the best", "the worst", "the greatest", "obviously", "clearly",
    "definitely", "absolutely", "undeniable", "impossible", "completely",
    "totally", "literally", "must be", "nothing can",
]

_WORD_RE = re.compile(r"[A-Za-z']+")
_SENT_RE = re.compile(r"[.!?]+")
_DIGIT_RE = re.compile(r"\d")
_PERCENT_RE = re.compile(r"\d+\s*(?:%|percent)", re.IGNORECASE)
_YEAR_PAREN_RE = re.compile(r"\(\s*(?:19|20)\d{2}[a-z]?\s*\)")
_MONEY_RE = re.compile(r"[$€£]\s?\d")
_STAT_TEST_RE = re.compile(
    r"\bp\s*[<=>]\s?0?\.\d|\bn\s*=\s*\d|\b\d+\s*(?:%|percent)\b",
    re.IGNORECASE,
)


def _count_markers(text: str, markers: Sequence[str]) -> int:
    return sum(1 for m in markers if m in text)


def _readability(text: str) -> List[float]:
    if _HAS_TEXTSTAT and text.strip():
        try:
            return [
                float(textstat.flesch_kincaid_grade(text)),
                float(textstat.gunning_fog(text)),
            ]
        except Exception:
            pass
    return [0.0, 0.0]


def _wordfreq_stats(words: List[str]) -> List[float]:
    if not words:
        return [0.0, 0.0]
    if _HAS_WORDFREQ:
        try:
            zips = [zipf_frequency(w.lower(), "en") for w in words]
            arr = np.asarray(zips, dtype=np.float64)
            return [float(arr.mean()), float((arr < 3.0).mean())]
        except Exception:
            pass
    return [0.0, 0.0]


FEATURE_NAMES: List[str] = [
    "n_words", "n_chars", "avg_word_len", "type_token_ratio",
    "n_sentences", "avg_sentence_len",
    "n_digits", "n_percent", "has_money",
    "n_citation_markers", "n_stat_markers", "n_hedges",
    "n_anecdote_markers", "n_superlative_markers",
    "n_first_person", "n_exclaim", "n_question", "n_quotes",
    "stat_test_pattern", "year_paren",
    "flesch_kincaid", "gunning_fog",
    "zipf_mean", "frac_rare_words",
]


def text_features(text: str) -> List[float]:
    """Compute the dense feature vector for one argument."""
    lower = text.lower()
    words = _WORD_RE.findall(text)
    n_words = max(len(words), 1)
    n_chars = len(text)
    sentences = [s for s in _SENT_RE.split(text) if s.strip()]
    n_sentences = max(len(sentences), 1)
    vocab = {w.lower() for w in words}

    first_person = sum(
        lower.count(f" {w} ") for w in ("i", "me", "my", "we", "our", "us")
    )

    fk, gf = _readability(text)
    zipf_mean, frac_rare = _wordfreq_stats(words)

    return [
        float(len(words)),
        float(n_chars),
        sum(len(w) for w in words) / n_words,
        len(vocab) / n_words,
        float(len(sentences)),
        len(words) / n_sentences,
        float(len(_DIGIT_RE.findall(text))),
        float(len(_PERCENT_RE.findall(text))),
        float(bool(_MONEY_RE.search(text))),
        float(_count_markers(lower, _CITATION_MARKERS)),
        float(_count_markers(lower, _STAT_MARKERS)),
        float(_count_markers(lower, _HEDGE_MARKERS)),
        float(_count_markers(lower, _ANECDOTE_MARKERS)),
        float(_count_markers(lower, _SUPERLATIVE_MARKERS)),
        float(first_person),
        float(text.count("!")),
        float(text.count("?")),
        float(text.count('"') + text.count("“") + text.count("”")) / 2.0,
        float(bool(_STAT_TEST_RE.search(text))),
        float(bool(_YEAR_PAREN_RE.search(text))),
        fk,
        gf,
        zipf_mean,
        frac_rare,
    ]


def texts_to_features(texts: Sequence[str]) -> sparse.csr_matrix:
    """Vectorise a list of arguments into a sparse feature block."""
    rows = np.asarray([text_features(t) for t in texts], dtype=np.float64)
    return sparse.csr_matrix(rows)

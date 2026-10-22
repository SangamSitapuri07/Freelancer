"""Optional post-processing rules for strength predictions.

Ported from the original ``smart_predictor.py`` (Drive: debate_coach_models/
complete_v3/smart_predictor.py) which layered WEAK -> MODERATE override rules
on top of BERT to fix its moderate-class under-prediction.

The rules are *opt-in* here: the balanced-corpus classifier is far less
prone to that failure mode, so ``CoachGenerator(analyze)`` only applies them
when ``smart_rules=True``.
"""

from __future__ import annotations

import re
from typing import Dict

WEAK_MARKERS = [
    "my friend", "my uncle", "someone told me", "i heard",
    "because i feel", "gut feeling", "just because",
    "everyone knows", "obviously true", "common sense",
    "a celebrity", "saw on facebook", "saw on social media",
    "youtube video", "anonymous blog", "read online",
    "flat earth", "earth is flat", "vaccines cause autism",
    "autism", "hoax", "conspiracy", "fake because",
    "lizard", "illuminati", "chemtrail",
    "because it snowed", "because it rained",
    "because i saw", "because i think",
    "my neighbor said", "they say that",
    "not smart enough", "you're just ignorant",
    "too scary", "don't care what scientists",
    "5g causes", "homeopathy cures",
    "astrology predicts", "moon landing was faked",
    "all politicians are", "always better than medicine",
]

REASONABLE_TOPICS = [
    "education", "technology", "environment", "health",
    "exercise", "mental health", "healthcare", "economy",
    "democracy", "transportation", "public", "society",
    "community", "culture", "diversity", "innovation",
    "research", "science", "policy", "climate",
    "sustainable", "renewable", "conservation",
    "literacy", "nutrition", "safety", "equality",
    "opportunity", "development", "wellbeing",
    "cooperation", "infrastructure", "affordable",
    "accessibility", "awareness", "prevention",
    "work-life balance", "financial", "civic",
]

REASONABLE_PATTERNS = [
    "is important", "should be", "can help",
    "has both", "positive and negative",
    "in many ways", "for society", "for everyone",
    "can benefit", "plays a role", "contributes to",
    "affects", "influences", "matters for",
    "deserves", "requires", "needs",
    "should consider", "worth noting",
    "can be harmful", "can be beneficial",
    "has improved", "has changed",
    "is a growing", "is a serious",
    "enriches", "strengthens",
]

EVIDENCE_WORDS = [
    "research", "studies", "data", "evidence",
    "according to", "shown that", "suggests that",
    "indicates", "demonstrates",
]


def apply_smart_rules(
    text: str, prediction: str, confidence: float
) -> Dict[str, object]:
    """Apply the WEAK -> MODERATE override rules.

    Returns ``{"prediction", "confidence", "original_prediction",
    "was_overridden"}``.
    """
    text_lower = text.lower().strip()
    original = prediction
    pred_label = prediction

    has_weak_marker = any(m in text_lower for m in WEAK_MARKERS)
    has_reasonable_topic = any(t in text_lower for t in REASONABLE_TOPICS)
    has_reasonable_pattern = any(p in text_lower for p in REASONABLE_PATTERNS)

    if pred_label == "weak":
        if not has_weak_marker and has_reasonable_topic and has_reasonable_pattern:
            pred_label, confidence = "moderate", 0.65
        elif not has_weak_marker and has_reasonable_topic and len(text) < 100:
            pred_label, confidence = "moderate", 0.55
        elif not has_weak_marker and has_reasonable_pattern:
            pred_label, confidence = "moderate", 0.60

    if pred_label == "weak":
        if any(w in text_lower for w in EVIDENCE_WORDS):
            pred_label, confidence = "moderate", 0.60

    if pred_label == "weak":
        has_numbers = bool(
            re.search(
                r"\d+%|\d+\s*(?:percent|countries|studies|years|participants)",
                text_lower,
            )
        )
        if has_numbers and not has_weak_marker:
            pred_label, confidence = "moderate", 0.65

    return {
        "prediction": pred_label,
        "confidence": confidence,
        "original_prediction": original,
        "was_overridden": original != pred_label,
    }

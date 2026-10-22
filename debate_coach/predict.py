"""CLI for the debate-coach generator.

Examples
--------
    python -m debate_coach.predict "Your argument text here"
    python -m debate_coach.predict --file examples.txt --smart-rules
    python -m debate_coach.predict --demo
"""

from __future__ import annotations

import argparse
import json
import sys

from .coach_generator import load_generator


DEMO_ARGUMENTS = [
    # strong: statistics + citation style
    "Data from World Bank spanning 33 years across 17 countries shows that "
    "bilingual education enhances cognitive flexibility in children, with a "
    "94% correlation.",
    # moderate: reasonable claim, thin evidence
    "It's imperative that science is discussed in someone's daily life. "
    "Science is done through research and data. Imagine if we had to listen "
    "to someone's opinion who has no factual basis or research done.",
    # weak: anecdote + fallacy
    "Allowing students to grade their teachers makes total sense because "
    "teachers who can't handle constructive criticism are probably not good "
    "at their jobs anyway. My friend, who's a teacher, said he got a really "
    "bad grade once and he was so sensitive about it.",
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", nargs="?", help="argument text to analyse")
    parser.add_argument("--file", help="analyse each non-empty line of a file")
    parser.add_argument("--smart-rules", action="store_true",
                        help="apply legacy WEAK->MODERATE override rules")
    parser.add_argument("--demo", action="store_true",
                        help="run three bundled demo arguments")
    parser.add_argument("--model", default=None, help="path to joblib bundle")
    args = parser.parse_args()

    kwargs = {"smart_rules": args.smart_rules}
    if args.model:
        kwargs["bundle_path"] = args.model
    coach = load_generator(**kwargs)

    texts: list[str] = []
    if args.demo:
        texts = DEMO_ARGUMENTS
    elif args.file:
        with open(args.file) as fh:
            texts = [line.strip() for line in fh if line.strip()]
    elif args.text:
        texts = [args.text]
    elif not sys.stdin.isatty():
        texts = [line.strip() for line in sys.stdin if line.strip()]
    else:
        parser.print_help()
        sys.exit(1)

    for text in texts:
        result = coach.analyze(text)
        print(json.dumps({"argument": text, **result}, indent=2, ensure_ascii=False))
        print("-" * 60)


if __name__ == "__main__":
    main()

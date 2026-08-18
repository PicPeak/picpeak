"""Audit i18n coverage for the face-recognition feature (#1074).

Extracts every t('key', ...) used by the face components and reports which
are missing from each locale file. A key that resolves only via its inline
`defaultValue` renders ENGLISH to a German user — which is exactly the gap
this looks for, and which nothing else in the toolchain would flag.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path('/Users/paul/Development/picpeak/frontend/src')

FILES = [
    'components/gallery/PeopleStrip.tsx',
    'components/gallery/PeopleSheet.tsx',
    'components/gallery/GalleryView.tsx',
    'components/gallery/PhotoLightbox.tsx',
    'components/admin/FaceRecognitionCard.tsx',
    'components/admin/PeopleManagerModal.tsx',
    'features/settings/tabs/FeaturesTab.tsx',
]

# Only keys belonging to this feature (plus shared keys the new components use).
RELEVANT = re.compile(r'^(gallery\.people\.|admin\.people\.|admin\.faces\.|settings\.features\.faces\.|common\.)')

KEY_RE = re.compile(r"\bt\(\s*'([a-zA-Z0-9_.]+)'")


def load(lang):
    with open(ROOT / 'i18n' / 'locales' / f'{lang}.json') as fh:
        return json.load(fh)


def has(data, dotted):
    node = data
    for part in dotted.split('.'):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return isinstance(node, str)


used = {}
for rel in FILES:
    path = ROOT / rel
    if not path.exists():
        print(f'!! missing file {rel}')
        continue
    for key in KEY_RE.findall(path.read_text()):
        if RELEVANT.match(key):
            used.setdefault(key, set()).add(rel.split('/')[-1])

print(f'{len(used)} face-related keys in use\n')

exit_code = 0
for lang in ('en', 'de'):
    data = load(lang)
    missing = sorted(k for k in used if not has(data, k))
    status = 'COMPLETE' if not missing else f'{len(missing)} MISSING'
    print(f'--- {lang.upper()}: {status} ---')
    for k in missing:
        print(f'    {k}   ({", ".join(sorted(used[k]))})')
    if missing:
        exit_code = 1
    print()

# Also flag DE values that are byte-identical to EN — usually an untranslated
# copy-paste rather than a word that genuinely matches in both languages.
en, de = load('en'), load('de')


def get(data, dotted):
    node = data
    for part in dotted.split('.'):
        node = node[part]
    return node


same = []
for k in sorted(used):
    if has(en, k) and has(de, k) and get(en, k) == get(de, k):
        same.append((k, get(en, k)))
if same:
    print(f'--- DE identical to EN ({len(same)}) — check each is intentional ---')
    for k, v in same:
        print(f'    {k} = {v!r}')

sys.exit(exit_code)

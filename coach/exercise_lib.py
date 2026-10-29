"""Exercise library: free-to-use picture sources behind one lookup.

    python coach/exercise_lib.py search dead bug      # find ids by name words (all sources)
    python coach/exercise_lib.py show Dead_Bug        # instructions, source, license, local image paths
    python coach/exercise_lib.py fetch Dead_Bug ...   # download images if missing

Sources, in order of preference when more than one has an exercise:
  ek-*      Everkinetic line drawings (~250 exercises, SVG, CC BY-SA 4.0 — credit "Everkinetic").
            Clean, consistent style; the first choice. Catalogue: coach/exercises/everkinetic.json
  <Name>    free-exercise-db photos (~870 exercises, JPG, public domain / Unlicense). Widest coverage.
            Catalogue: coach/exercises/exercises.json
  own-*     This person's own pictures: drawings their Claude made, or their photos.
            <data>/media/own.json + <data>/media/own/<id>/0.svg|jpg, 1.svg|jpg

The app ships only the catalogues (names, instructions, links). Pictures download on demand
into the person's data folder (<data>/media/), only for exercises their plan uses.
Every exercise has two images: start and end position.
"""

import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402

CATALOGUE = str(paths.CATALOGUE)
LIB_DIR = str(paths.MEDIA)  # where pictures live; phone_assets.json keys are relative to this

SOURCES = {
    "free-exercise-db": {
        "dir": os.path.join(LIB_DIR, "free-exercise-db"),
        "url": "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/",
        "license": "Public domain (Unlicense), free-exercise-db",
    },
    "everkinetic": {
        "dir": os.path.join(LIB_DIR, "everkinetic"),
        "url": "https://raw.githubusercontent.com/everkinetic/data/main/dist/svg/",
        "license": "CC BY-SA 4.0, Everkinetic",
    },
    "own": {
        "dir": os.path.join(LIB_DIR, "own"),
        "url": None,
        "license": "Own picture",
    },
}


def _read(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load():
    """All exercises by id, normalised to: id, name, source, license, equipment, level,
    primaryMuscles, instructions, images (paths relative to the source's dir)."""
    out = {}
    for x in _read(os.path.join(CATALOGUE, "exercises.json")):
        out[x["id"]] = {**x, "source": "free-exercise-db"}
    for x in _read(os.path.join(CATALOGUE, "everkinetic.json")):
        if not x.get("img"):  # no drawings for this one upstream
            continue
        i = "ek-" + x["name"]
        out[i] = {
            "id": i,
            "name": x["title"],
            "source": "everkinetic",
            "equipment": ", ".join(x.get("equipment") or []) or "body only",
            "level": "",
            "primaryMuscles": [x["primary"]] if x.get("primary") else [],
            "secondaryMuscles": x.get("secondary") or [],
            "instructions": x.get("steps") or [],
            "images": [f"{x['id_num']}-relaxation.svg", f"{x['id_num']}-tension.svg"],
        }
    for x in _read(os.path.join(LIB_DIR, "own.json")):
        out[x["id"]] = {**x, "source": "own"}
    for x in out.values():
        x["license"] = x.get("license") or SOURCES[x["source"]]["license"]
    return out


def search(words, lib=None):
    lib = lib or load()
    words = [w.lower() for w in words]
    hits = [x for x in lib.values() if all(w in x["name"].lower() or w in x["id"].lower() for w in words)]
    order = {"everkinetic": 0, "own": 1, "free-exercise-db": 2}
    return sorted(hits, key=lambda x: (order[x["source"]], x["name"]))


def image_paths(ex):
    """Local paths of an exercise's images (start, end)."""
    d = SOURCES[ex["source"]]["dir"]
    return [os.path.join(d, p.replace("/", os.sep)) for p in ex["images"]]


def fetch(ex_id, lib=None):
    """Download an exercise's images if missing; return local paths."""
    lib = lib or load()
    ex = lib[ex_id]
    url = SOURCES[ex["source"]]["url"]
    local = image_paths(ex)
    for rel, path in zip(ex["images"], local):
        if url and not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            urllib.request.urlretrieve(url + rel, path + ".tmp")
            os.replace(path + ".tmp", path)
    return local


if __name__ == "__main__":
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    lib = load()
    if cmd == "search":
        for x in search(args, lib):
            print(f"{x['id']:45} {x['source']:17} {x.get('equipment') or '-'}")
    elif cmd == "show":
        for i in args:
            x = lib[i]
            print(x["name"], "|", x["source"], "|", x["license"], "|", x.get("equipment"))
            for line in x.get("instructions", []):
                print("  -", line)
            print("  images:", image_paths(x))
    elif cmd == "fetch":
        for i in args:
            print(i, fetch(i, lib))
    else:
        print(__doc__)

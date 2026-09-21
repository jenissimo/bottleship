#!/usr/bin/env python3
"""Build a self-contained, static HTML catalog from BottleShip .wgb bundles.

The script never modifies the game bundles.  It reads their manifest.json files,
downloads metadata/covers where a public store API can identify a game, and writes
an index.html that can be opened directly or served by any ordinary web server.

Examples:
  python3 generate-game-catalog.py /share/games/apps /share/games/catalog
  python generate-game-catalog.py "\\\\192.168.0.50\\share\\games\\apps" .\\game-catalog
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

USER_AGENT = "BottleShipGameCatalog/1.0 (+https://github.com/bottleship-oss)"
HTTP_TIMEOUT_SECONDS = 20
MAX_DESCRIPTION = 450


@dataclass
class Game:
    filename: str
    title: str
    game_id: str
    size_bytes: int
    updated_at: str
    description: str = ""
    year: str = ""
    genres: list[str] | None = None
    cover: str = ""
    source: str = "manifest only"

    def to_json(self) -> dict[str, Any]:
        result = asdict(self)
        result["genres"] = self.genres or []
        return result


def request_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.load(response)


def download(url: str, target: Path) -> bool:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response, target.open("wb") as output:
            shutil.copyfileobj(response, output)
        return target.stat().st_size > 0
    except Exception as error:  # Network enrichment is deliberately best-effort.
        target.unlink(missing_ok=True)
        print(f"  ! cover unavailable: {error}", file=sys.stderr)
        return False


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value or "")
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def normalized(value: str) -> str:
    value = value.lower().replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "", value)


def title_from_manifest(bundle: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(bundle) as archive:
            manifest_name = next((name for name in archive.namelist() if name.lower() == "manifest.json"), None)
            if not manifest_name:
                raise ValueError("manifest.json not found")
            manifest = json.loads(archive.read(manifest_name).decode("utf-8"))
        return str(manifest.get("title") or manifest.get("name") or bundle.stem), str(manifest.get("gameId") or "")
    except Exception as error:
        print(f"  ! {bundle.name}: cannot read manifest ({error})", file=sys.stderr)
        return bundle.stem, ""


def steam_metadata(title: str) -> dict[str, Any] | None:
    """Find an exact or very-close Steam result, then request its public details."""
    try:
        query = urllib.parse.urlencode({"term": title, "l": "english", "cc": "US"})
        results = request_json(f"https://store.steampowered.com/api/storesearch/?{query}").get("items", [])
        wanted = normalized(title)
        best = next((item for item in results if normalized(str(item.get("name", ""))) == wanted), None)
        if not best:
            return None
        app_id = best["id"]
        details = request_json(f"https://store.steampowered.com/api/appdetails?appids={app_id}&l=english")
        data = details.get(str(app_id), {}).get("data")
        if not data:
            return None
        return {
            "description": clean_text(data.get("short_description", "")),
            "year": (data.get("release_date", {}).get("date", "").rsplit(" ", 1)[-1]),
            "genres": [genre["description"] for genre in data.get("genres", [])],
            "cover_url": f"https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/library_600x900.jpg",
            "source": "Steam public catalog",
        }
    except Exception as error:
        print(f"  ! Steam lookup failed for {title!r}: {error}", file=sys.stderr)
        return None


def gog_metadata(game_id: str) -> dict[str, Any] | None:
    if not game_id.startswith("gog:"):
        return None
    try:
        product_id = urllib.parse.quote(game_id.split(":", 1)[1])
        data = request_json(f"https://api.gog.com/products/{product_id}?expand=description,developers,genres")
        image = data.get("image")
        return {
            "description": clean_text(data.get("description", "")),
            "year": str(data.get("releaseDate", ""))[:4],
            "genres": [genre.get("name", "") for genre in data.get("genres", []) if genre.get("name")],
            "cover_url": f"https:{image.replace('{formatter}', 'product_card_v2_mobile_slider_639', 1)}" if image else "",
            "source": "GOG public catalog",
        }
    except Exception as error:
        print(f"  ! GOG lookup failed for {game_id}: {error}", file=sys.stderr)
        return None


def safe_stem(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "game"


def enrich(game: Game, covers_dir: Path, online: bool) -> None:
    if not online:
        return
    metadata = gog_metadata(game.game_id) or steam_metadata(game.title)
    if not metadata:
        return
    game.description = metadata["description"][:MAX_DESCRIPTION]
    game.year = metadata["year"] if re.fullmatch(r"\d{4}", metadata["year"] or "") else ""
    game.genres = metadata["genres"]
    game.source = metadata["source"]
    if metadata["cover_url"]:
        cover_name = safe_stem(game.game_id or game.title) + ".jpg"
        target = covers_dir / cover_name
        if target.exists() or download(metadata["cover_url"], target):
            game.cover = f"covers/{cover_name}"


def render(games: list[Game]) -> str:
    payload = json.dumps([game.to_json() for game in games], ensure_ascii=False).replace("</", "<\\/")
    return f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Коллекция игр</title><style>
:root{{color-scheme:dark;--bg:#0b0d13;--panel:#151926;--ink:#f2f5ff;--muted:#a9b1c7;--accent:#9b7bff}}
*{{box-sizing:border-box}} body{{margin:0;background:radial-gradient(circle at top,#25213e 0,var(--bg) 47%);color:var(--ink);font:16px/1.45 system-ui,sans-serif}}
main{{max-width:1400px;margin:auto;padding:48px 28px 70px}} h1{{font-size:clamp(2rem,5vw,4rem);letter-spacing:-.06em;margin:0}} header p{{color:var(--muted);margin:10px 0 30px}}
input{{width:min(480px,100%);padding:13px 16px;border:1px solid #353b52;border-radius:10px;background:#0e111b;color:var(--ink);font:inherit}}
#count{{color:var(--muted);margin:20px 0}} #grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:20px}}
.card{{overflow:hidden;border:1px solid #2d3345;border-radius:14px;background:var(--panel);box-shadow:0 12px 32px #0004;transition:transform .18s,border-color .18s}}.card:hover{{transform:translateY(-5px);border-color:var(--accent)}}
.cover{{height:270px;background:linear-gradient(145deg,#2b3150,#121521);display:grid;place-items:center;overflow:hidden}}.cover img{{width:100%;height:100%;object-fit:cover}}.fallback{{color:#d9d0ff;font-weight:700;text-align:center;padding:18px;font-size:1.25rem}}
.info{{padding:14px 15px 16px}}h2{{font-size:1.05rem;line-height:1.2;margin:0 0 8px}}.meta{{color:var(--muted);font-size:.82rem;margin:0 0 9px}}.description{{font-size:.86rem;color:#c8cde0;margin:0;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}}.empty{{color:var(--muted)}}
</style></head><body><main><header><h1>Коллекция игр</h1><p>Личный каталог · <span id="total"></span></p><input id="search" autofocus placeholder="Найти игру, жанр или год…"></header><div id="count"></div><section id="grid"></section></main>
<script>const games={payload};const q=document.querySelector('#search'),grid=document.querySelector('#grid'),count=document.querySelector('#count');document.querySelector('#total').textContent=`${{games.length}} игр`;
function esc(v){{const x=document.createElement('span');x.textContent=v||'';return x.innerHTML}}function draw(){{const term=q.value.trim().toLowerCase();const shown=games.filter(g=>[g.title,g.year,...g.genres].join(' ').toLowerCase().includes(term));count.textContent=term?`Найдено: ${{shown.length}}`:`Показано: ${{shown.length}}`;grid.innerHTML=shown.map(g=>`<article class="card"><div class="cover">${{g.cover?`<img loading="lazy" src="${{esc(g.cover)}}" alt="Обложка: ${{esc(g.title)}}">`:`<div class="fallback">${{esc(g.title)}}</div>`}}</div><div class="info"><h2>${{esc(g.title)}}</h2><p class="meta">${{esc([g.year,...g.genres].filter(Boolean).join(' · '))}}</p>${{g.description?`<p class="description">${{esc(g.description)}}</p>`:''}}</div></article>`).join('')||'<p class="empty">Ничего не найдено.</p>'}}q.addEventListener('input',draw);draw();</script></body></html>'''


def bottleship_catalog(games: list[Game]) -> list[dict[str, Any]]:
    """Shape used by the BottleShip game-select screen.

    The bundles stay in the existing mounted apps directory; their original names
    are URL-escaped instead of copied or renamed.
    """
    taken: set[str] = set()
    entries: list[dict[str, Any]] = []
    for game in games:
        base = safe_stem(game.game_id or game.title)
        game_key = base
        number = 2
        while game_key in taken:
            game_key = f"{base}-{number}"
            number += 1
        taken.add(game_key)
        entries.append({
            "id": game_key,
            "name": game.title,
            "subtitle": "",
            "wgbUrl": "/apps/" + urllib.parse.quote(game.filename),
            "coverUrl": "/" + game.cover if game.cover else "",
            "description": game.description,
            "year": game.year,
            "genre": " · ".join(game.genres or []),
            "enabled": True,
        })
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a static catalog for BottleShip .wgb games.")
    parser.add_argument("games_dir", type=Path, help="directory containing .wgb bundles")
    parser.add_argument("output_dir", type=Path, help="directory for index.html, games.json and covers")
    parser.add_argument("--offline", action="store_true", help="skip public catalog lookups and generate from manifests only")
    parser.add_argument("--bottleship-dist", type=Path, metavar="DIR", help="also write games-catalog.json and covers into a pre-built BottleShip dist directory")
    args = parser.parse_args()
    if not args.games_dir.is_dir():
        parser.error(f"game directory does not exist: {args.games_dir}")
    bundles = sorted(args.games_dir.glob("*.wgb"), key=lambda path: path.name.lower())
    if not bundles:
        parser.error("no .wgb bundles found")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    covers_dir = args.output_dir / "covers"; covers_dir.mkdir(exist_ok=True)
    games: list[Game] = []
    for bundle in bundles:
        title, game_id = title_from_manifest(bundle)
        game = Game(bundle.name, title, game_id, bundle.stat().st_size, datetime.fromtimestamp(bundle.stat().st_mtime, timezone.utc).isoformat())
        print(f"• {title}")
        enrich(game, covers_dir, not args.offline)
        games.append(game)
    games.sort(key=lambda game: game.title.casefold())
    (args.output_dir / "games.json").write_text(json.dumps([game.to_json() for game in games], ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output_dir / "index.html").write_text(render(games), encoding="utf-8")
    if args.bottleship_dist:
        if not (args.bottleship_dist / "index.html").is_file():
            parser.error(f"BottleShip build not found: {args.bottleship_dist / 'index.html'}")
        target_covers = args.bottleship_dist / "covers"
        target_covers.mkdir(exist_ok=True)
        for cover in covers_dir.iterdir():
            if cover.is_file():
                shutil.copy2(cover, target_covers / cover.name)
        (args.bottleship_dist / "games-catalog.json").write_text(
            json.dumps(bottleship_catalog(games), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"BottleShip library ready: {(args.bottleship_dist / 'games-catalog.json').resolve()}")
    print(f"\nCatalog ready: {(args.output_dir / 'index.html').resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import React from "react";
import {
  GearSix,
  MagnifyingGlass,
  Folder,
  FolderPlus,
  GridFour,
  List,
  ArrowsDownUp,
  CaretDown,
  UploadSimple,
  Play,
  PencilSimple,
  X,
  GithubLogo,
  HandHeart,
} from "@phosphor-icons/react";
import type { AddedGame } from "../wgb-library";
import { cx } from "../ui/cx";
import s from "./GameSelectScreen.module.css";
import ib from "../ui/IconButton/IconButton.module.css";
import bm from "../ui/Button/Button.module.css";

export interface GameEntry {
  id: string;
  name: string;
  subtitle: string;
  wgbUrl: string;
  description: string;
  year: string;
  genre: string;
  coverUrl: string;
  os?: string;
  render?: string;
  status?: "ready" | "setup" | "save";
  gogUrl?: string;
  /** Download the bundle to OPFS before starting instead of streaming it on demand.
   *  Worth it wherever range round-trips are expensive (self-hosted stand behind a
   *  reverse proxy, high-RTT link): one sequential download beats hundreds of reads. */
  preload?: boolean;
}

interface GameSelectScreenProps {
  games: GameEntry[];
  addedGames?: AddedGame[];
  onSelectGame: (game: GameEntry) => void;
  onPlayAdded?: (game: AddedGame) => void;
  onRemoveAdded?: (game: AddedGame) => void;
  onEditAdded?: (game: AddedGame) => void;
  onAddGame: () => void;
  onDevMode: () => void;
  onManageStorage?: () => void;
  onOpenSettings?: () => void;
  disableSelection?: boolean;
  unsupportedMessage?: string | null;
  /** Banner heading above unsupportedMessage. Defaults to the browser-capability wording. */
  unsupportedTitle?: string;
}

type SourceFilter = "all" | "builtin" | "gog" | "local";
type SortMode = "added" | "played" | "title" | "year";
type ViewMode = "grid" | "list";

const SORT_LABELS: Record<SortMode, string> = {
  added: "Recently added",
  played: "Recently played",
  title: "Title (A–Z)",
  year: "Year",
};

interface SupportLink {
  label: string;
  url: string;
}

// Donation targets shown in the header "Support" menu. Append as more are added.
const SUPPORT_LINKS: SupportLink[] = [
  { label: "Ko-fi", url: "https://ko-fi.com/bottleship" },
  { label: "CloudTips (RU)", url: "https://pay.cloudtips.ru/p/e2362fd1" },
  { label: "Crypto", url: "https://nowpayments.io/donation/bottleship" },
];

function isGogAdded(game: AddedGame): boolean {
  const hay = `${game.key} ${game.url}`.toLowerCase();
  return hay.includes("gog");
}

export default function GameSelectScreen({
  games,
  addedGames = [],
  onSelectGame,
  onPlayAdded,
  onRemoveAdded,
  onEditAdded,
  onAddGame,
  onDevMode,
  onManageStorage,
  onOpenSettings,
  disableSelection = false,
  unsupportedMessage = null,
  unsupportedTitle = "Unsupported browser",
}: GameSelectScreenProps) {
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<ViewMode>("grid");
  const [source, setSource] = React.useState<SourceFilter>("all");
  const [sort, setSort] = React.useState<SortMode>("added");
  const [srcMenuOpen, setSrcMenuOpen] = React.useState(false);
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const [supportMenuOpen, setSupportMenuOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const srcWrapRef = React.useRef<HTMLDivElement>(null);
  const sortWrapRef = React.useRef<HTMLDivElement>(null);
  const supportWrapRef = React.useRef<HTMLDivElement>(null);

  const openSettings = onOpenSettings ?? onManageStorage ?? (() => {});
  const totalGames = games.length + addedGames.length;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!srcMenuOpen && !sortMenuOpen && !supportMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!srcWrapRef.current?.contains(t) && !sortWrapRef.current?.contains(t) && !supportWrapRef.current?.contains(t)) {
        setSrcMenuOpen(false);
        setSortMenuOpen(false);
        setSupportMenuOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [srcMenuOpen, sortMenuOpen, supportMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);

  const visibleBuiltin =
    source === "all" || source === "builtin" ? games.filter((g) => matches(g.name)) : [];
  const visibleAdded =
    source === "all" || source === "local" || source === "gog"
      ? addedGames.filter((g) => {
          if (source === "gog" && !isGogAdded(g)) return false;
          if (source === "local" && isGogAdded(g)) return false;
          return matches(g.name);
        })
      : [];

  const builtinCount = games.length;
  const gogCount = addedGames.filter(isGogAdded).length;
  const localCount = addedGames.length - gogCount;

  const isFirstRun = addedGames.length === 0 && games.length === 0;

  return (
    <div className={s["shell"]}>
      <header className={s["cmdbar"]}>
        <div className={s["brand"]}>
          <div className={s["brand__mark"]}>
            <img src="/bottleship_logo.png" className={s["brand__bottle"]} alt="BottleShip" />
            <span className={s["wordmark"]}>
              Bottle<b>Ship</b>
            </span>
          </div>
          <span className={s["brand__tag"]}>Run classic Windows games in your browser.</span>
        </div>
        <span className={s["cmd-spacer"]} />
        <div className={s["cmd-actions"]}>
          <div ref={supportWrapRef} className={s["srcwrap"]}>
            <button
              className={cx(bm, "btn", "btn--primary")}
              onClick={(e) => {
                e.stopPropagation();
                setSupportMenuOpen((o) => !o);
                setSrcMenuOpen(false);
                setSortMenuOpen(false);
              }}
              title="Support BottleShip"
            >
              <HandHeart size={16} weight="fill" aria-hidden />
              Support
            </button>
            <div className={cx(s, "menu", "menu--right", supportMenuOpen && "is-open")} style={{ minWidth: 176 }}>
              <div className={s["menuhead"]}>Support development</div>
              {SUPPORT_LINKS.map((l) => (
                <a
                  key={l.url}
                  className={s["menuitem"]}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setSupportMenuOpen(false)}
                >
                  {l.label}
                </a>
              ))}
            </div>
          </div>
          <a
            className={ib["iconbtn"]}
            href="https://github.com/jenissimo/bottleship"
            target="_blank"
            rel="noopener noreferrer"
            title="View source on GitHub"
            aria-label="GitHub repository"
          >
            <GithubLogo size={18} weight="fill" aria-hidden />
          </a>
          <button className={ib["iconbtn"]} title="Settings" onClick={() => openSettings()}>
            <GearSix size={19} aria-hidden />
          </button>
        </div>
      </header>

      {isFirstRun ? (
        <section className={s["hero"]}>
          <img src="/bottleship_logo.png" className={s["hero__bottle"]} alt="BottleShip" />
          <div className={s["hero__t"]}>Turn classic Windows games into browser-playable packages.</div>
          <div className={s["hero__h"]}>
            Drop a GOG installer, a folder, a ZIP, or a .wgb file. BottleShip runs it locally with
            WebAssembly + WebGPU — nothing is uploaded.
          </div>
          <div className={s["hero__cta"]}>
            <button className={cx(bm, "btn", "btn--primary")} onClick={() => !disableSelection && onAddGame()} disabled={disableSelection}>
              + Add your first game
            </button>
          </div>
          {unsupportedMessage && (
            <div className={s["lib__unsupported"]} style={{ marginTop: 28, textAlign: "left" }}>
              <div className={s["lib__unsupported-title"]}>{unsupportedTitle}</div>
              <div>{unsupportedMessage}</div>
            </div>
          )}
        </section>
      ) : (
        <div>
          <div className={s["libhead"]}>
            <h2>Library</h2>
            <span className={s["sub"]}>{totalGames} games · on this machine</span>
          </div>

          {unsupportedMessage && (
            <div className={s["lib__unsupported"]}>
              <div className={s["lib__unsupported-title"]}>{unsupportedTitle}</div>
              <div>{unsupportedMessage}</div>
            </div>
          )}

          <div className={s["filters"]}>
            <label className={s["search"]}>
              <MagnifyingGlass size={15} aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search games, packages, installers…"
              />
              <kbd>/</kbd>
            </label>

            <div ref={srcWrapRef} className={s["srcwrap"]}>
              <button
                className={s["srcsel"]}
                onClick={(e) => {
                  e.stopPropagation();
                  setSrcMenuOpen((o) => !o);
                  setSortMenuOpen(false);
                }}
              >
                <Folder size={15} aria-hidden />
                {source === "all"
                  ? "All sources"
                  : source === "builtin"
                  ? "Built-in"
                  : source === "gog"
                  ? "GOG"
                  : "Local files"}
                <CaretDown className={s["caret"]} size={14} aria-hidden />
              </button>
              <div className={cx(s, "menu", srcMenuOpen && "is-open")}>
                <div
                  className={cx(s, "menuitem", source === "all" && "is-active")}
                  onClick={() => {
                    setSource("all");
                    setSrcMenuOpen(false);
                  }}
                >
                  All sources <span className={s["ct"]}>{totalGames}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "builtin" && "is-active")}
                  onClick={() => {
                    setSource("builtin");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--cyan)" }} /> Built-in{" "}
                  <span className={s["ct"]}>{builtinCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "gog" && "is-active")}
                  onClick={() => {
                    setSource("gog");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--amber)" }} /> GOG{" "}
                  <span className={s["ct"]}>{gogCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "local" && "is-active")}
                  onClick={() => {
                    setSource("local");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--violet)" }} /> Local files{" "}
                  <span className={s["ct"]}>{localCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", "menuitem--mount")}
                  onClick={() => {
                    setSrcMenuOpen(false);
                    onManageStorage?.();
                  }}
                >
                  <FolderPlus size={14} aria-hidden /> Mount a folder…
                </div>
              </div>
            </div>

            <span className={s["filters__spacer"]} />

            <div className={s["viewtoggle"]}>
              <button
                className={cx(s, "vt", view === "grid" && "is-active")}
                title="Grid"
                onClick={() => setView("grid")}
              >
                <GridFour size={15} aria-hidden />
              </button>
              <button
                className={cx(s, "vt", view === "list" && "is-active")}
                title="List"
                onClick={() => setView("list")}
              >
                <List size={15} aria-hidden />
              </button>
            </div>

            <div ref={sortWrapRef} className={s["sortwrap"]}>
              <button
                className={s["sortsel"]}
                onClick={(e) => {
                  e.stopPropagation();
                  setSortMenuOpen((o) => !o);
                  setSrcMenuOpen(false);
                }}
              >
                <ArrowsDownUp size={14} aria-hidden />
                <span className={s["muted"]}>{SORT_LABELS[sort]}</span>
                <CaretDown className={s["caret"]} size={14} aria-hidden />
              </button>
              <div className={cx(s, "menu", "menu--right", sortMenuOpen && "is-open")}>
                {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                  <div
                    key={mode}
                    className={cx(s, "menuitem", sort === mode && "is-active")}
                    onClick={() => {
                      setSort(mode);
                      setSortMenuOpen(false);
                    }}
                  >
                    {SORT_LABELS[mode]}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={cx(s, "shelf", view === "list" && "shelf--list")}>
            <article
              className={cx(s, "card", "card--add")}
              style={{ animationDelay: "0ms" }}
              onClick={() => !disableSelection && onAddGame()}
              role="button"
              tabIndex={disableSelection ? -1 : 0}
              onKeyDown={(e) => {
                if (!disableSelection && (e.key === "Enter" || e.key === " ")) onAddGame();
              }}
            >
              <div className={s["add-body"]}>
                <div className={s["add-glyph"]}>
                  <UploadSimple size={24} aria-hidden />
                </div>
                <div className={s["add-title"]}>Add a game</div>
                <div className={s["add-hint"]}>
                  Drop a .wgb package, GOG
                  <br />
                  installer, ZIP, or folder
                </div>
              </div>
            </article>

            {visibleBuiltin.map((game, i) => (
              <BuiltinCard
                key={game.id}
                game={game}
                index={i + 1}
                onPlay={() => onSelectGame(game)}
                disabled={disableSelection}
              />
            ))}

            {visibleAdded.map((game, i) => (
              <AddedCard
                key={`byo:${game.key}`}
                game={game}
                index={visibleBuiltin.length + i + 1}
                onPlay={() => onPlayAdded?.(game)}
                onRemove={() => onRemoveAdded?.(game)}
                onEdit={() => onEditAdded?.(game)}
                disabled={disableSelection}
              />
            ))}
          </div>

          <div className={s["statusbar"]}>
            <span className={s["ok"]}>WebGPU ready</span>
            <span className={s["sep"]}>·</span>
            <span>x86 HLE · WASM</span>
            <span className={s["sep"]}>·</span>
            <span>{totalGames} games</span>
            <span className={s["spacer"]} />
            <span className={s["priv"]}>Local only — your games never leave this machine</span>
            <span className={s["sep"]}>·</span>
            <a onClick={() => onManageStorage?.()}>Storage</a>
            <span className={s["sep"]}>·</span>
            <a onClick={() => !disableSelection && onDevMode()}>Developer</a>
          </div>
        </div>
      )}
    </div>
  );
}

function specLine(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function StatusPill({ status }: { status?: "ready" | "setup" | "save" }): React.ReactElement | null {
  if (status === "setup") return <span className={cx(s, "st", "st--setup")}>Needs setup</span>;
  if (status === "save") return <span className={cx(s, "st", "st--save")}>Save available</span>;
  return <span className={cx(s, "st", "st--ready")}>Ready</span>;
}

function Cover({
  coverUrl,
  name,
  badge,
}: {
  coverUrl?: string;
  name: string;
  badge: React.ReactNode;
}): React.ReactElement {
  const glyph = name.slice(0, 1).toUpperCase();
  return (
    <>
      <div className={s["card__fallback"]}>
        <span className={s["card__glyph"]}>{glyph}</span>
      </div>
      {coverUrl && (
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      {badge}
    </>
  );
}

function BuiltinCard({
  game,
  index,
  onPlay,
  disabled,
}: {
  game: GameEntry;
  index: number;
  onPlay: () => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <article
      className={cx(s, "card", disabled && "card--disabled")}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={() => !disabled && onPlay()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) onPlay();
      }}
    >
      <div className={s["card__cover"]}>
        <Cover
          coverUrl={game.coverUrl}
          name={game.name}
          badge={<span className={cx(s, "badge", "badge--builtin")}>Built-in</span>}
        />
        {game.subtitle ? <span className={cx(s, "badge", "badge--sub")}>{game.subtitle}</span> : null}
        <div className={s["card__play"]}>
          {disabled ? (
            <div className={s["card__locked"]}>Unavailable</div>
          ) : (
            <div className={s["play-btn"]}>
              <Play size={20} fill="currentColor" aria-hidden />
            </div>
          )}
        </div>
      </div>
      <div className={s["card__info"]}>
        <div className={s["card__name"]}>{game.name}</div>
        <div className={s["card__spec"]}>{specLine([game.genre, game.os, game.render])}</div>
        <div className={s["card__foot"]}>
          <StatusPill status={game.status} />
          <span className={s["card__year"]}>{game.year}</span>
        </div>
      </div>
    </article>
  );
}

function AddedCard({
  game,
  index,
  onPlay,
  onRemove,
  onEdit,
  disabled,
}: {
  game: AddedGame;
  index: number;
  onPlay: () => void;
  onRemove: () => void;
  onEdit: () => void;
  disabled: boolean;
}): React.ReactElement {
  const gog = isGogAdded(game);
  return (
    <article
      className={cx(s, "card", disabled && "card--disabled")}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={() => !disabled && onPlay()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) onPlay();
      }}
    >
      <div className={s["card__cover"]}>
        <Cover
          coverUrl={game.coverUrl}
          name={game.name}
          badge={
            <span className={cx(s, "badge", gog ? "badge--gog" : "badge--local")}>{gog ? "GOG" : "Local"}</span>
          }
        />
        <div className={s["card__tools"]}>
          <button
            className={s["tool"]}
            title="Edit manifest"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <PencilSimple size={13} aria-hidden />
          </button>
          <button
            className={cx(s, "tool", "tool--danger")}
            title="Remove from library"
            onClick={(e) => {
              e.stopPropagation();
              if (
                confirm(
                  `Remove "${game.name}" from your library? The cached bundle is deleted (re-add anytime).`,
                )
              ) {
                onRemove();
              }
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className={s["card__play"]}>
          {disabled ? (
            <div className={s["card__locked"]}>Unavailable</div>
          ) : (
            <div className={s["play-btn"]}>
              <Play size={20} fill="currentColor" aria-hidden />
            </div>
          )}
        </div>
      </div>
      <div className={s["card__info"]}>
        <div className={s["card__name"]}>{game.name}</div>
        <div className={s["card__spec"]}>{specLine([game.developer, ".wgb package"])}</div>
        <div className={s["card__foot"]}>
          <StatusPill status="ready" />
          <span className={s["card__year"]}>{game.year ?? "—"}</span>
        </div>
      </div>
    </article>
  );
}

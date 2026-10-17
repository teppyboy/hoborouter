import * as React from "react";
import { ChevronsUpDown, Search } from "lucide-react";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useLocaleStore } from "../../lib/i18n/locale";
import { useComposerT } from "./composer-copy";
import {
  EFFORT_LABELS,
  EFFORT_UNSET,
  supportedEffortOptions,
  type ReasoningEffort,
} from "./reasoning";

/** One public catalog model option. Only server-published public IDs and
 *  display names cross this boundary — raw upstream model keys never do. */
export interface PublicModelOption {
  publicId: string;
  displayName: string | null;
  reasoning?: { supported_efforts: string[]; default_effort: string | null } | null;
}

export interface ModelControlsProps {
  models: PublicModelOption[];
  loading: boolean;
  error: string | null;
  /** Selected public model ID ("" = none yet). */
  value: string;
  onModelChange(publicId: string): void;
  effort: string;
  onEffortChange(effort: string): void;
  disabled?: boolean;
  /** DOM id for the pill trigger (E2E/label anchors, e.g. "chat-model"). */
  id?: string;
}

/** Model pill with a searchable picker plus the effort selector, as
 *  controlled props so the chat page (index.tsx) stays the state owner.
 *  Search filters ONLY the passed-in public catalog list; the effort
 *  selector offers only the selected model's authored supported_efforts
 *  (never the full ladder, never inferred options). */
export function ModelControls(props: ModelControlsProps): React.ReactElement {
  const { models, loading, error, value, onModelChange, effort, onEffortChange, disabled, id } =
    props;
  const t = useComposerT();
  const locale = useLocaleStore((s) => s.locale);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const pillRef = React.useRef<HTMLButtonElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const panelId = React.useId();

  const selected = models.find((m) => m.publicId === value) ?? null;
  const effortOptions = supportedEffortOptions(selected?.reasoning);
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        (m.displayName ?? "").toLowerCase().includes(q) || m.publicId.toLowerCase().includes(q),
    );
  }, [models, query]);

  // Popover focus contract: opening lands focus in the search field; closing
  // (Esc or pick) returns focus to the pill. No focus is stolen on mount.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) searchRef.current?.focus();
    if (!open && wasOpen.current) pillRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function pick(publicId: string) {
    onModelChange(publicId);
    setOpen(false);
  }

  const pillLabel = selected
    ? (selected.displayName ?? selected.publicId)
    : loading
      ? t("loadingModels")
      : error
        ? t("modelsUnavailable")
        : t("chooseModel");

  return (
    <>
      <div className="relative min-w-0 flex-1 sm:flex-none">
        <button
          ref={pillRef}
          type="button"
          id={id}
          disabled={disabled || models.length === 0}
          onClick={() => {
            setQuery("");
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={panelId}
          aria-label={t("model")}
          className="flex h-9 w-full min-w-0 max-w-56 items-center justify-between gap-1 rounded-md bg-muted/50 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11"
        >
          <span className="min-w-0 truncate">{pillLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        {open && (
          <div
            id={panelId}
            role="listbox"
            aria-label={t("model")}
            className="absolute left-0 top-10 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-1 shadow-md"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            onBlur={(e) => {
              // Close when focus leaves the panel entirely (search field,
              // options and the panel itself stay "inside").
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
            }}
          >
            <div className="relative p-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchRef}
                type="text"
                role="searchbox"
                aria-label={t("searchModelsLabel")}
                placeholder={t("searchModels")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {filtered.map((m) => (
                <li key={m.publicId} role="option" aria-selected={m.publicId === value}>
                  <button
                    type="button"
                    onClick={() => pick(m.publicId)}
                    className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent ${
                      m.publicId === value ? "font-medium" : ""
                    }`}
                  >
                    <span className="min-w-0 truncate">{m.displayName ?? m.publicId}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {m.publicId === value ? "✓" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">{t("noModelsFound")}</p>
            )}
          </div>
        )}
      </div>
      {effortOptions.length > 0 && (
        <Select value={effort} onValueChange={onEffortChange}>
          <SelectTrigger
            id="chat-effort"
            aria-label={t("effort")}
            className="h-9 w-36 gap-1 border-0 bg-muted/50 shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EFFORT_UNSET}>{t("effortDefault")}</SelectItem>
            {effortOptions.map((e: ReasoningEffort) => (
              <SelectItem key={e} value={e}>
                {EFFORT_LABELS[e][locale]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );
}

import * as React from "react";
import { MessageSquare, Send, Square } from "lucide-react";
import { createSseParser, type StreamDelta } from "./sse";
import { renderMarkdown } from "../legal/legal-page";
import { EmptyState, ErrorState, PageHeader } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

// The pasted sk-hbr- key lives in memory (component state) only by default;
// "remember for this tab" opts into sessionStorage, which dies with the tab.
// Never localStorage, never logged, never sent anywhere except the gateway
// Authorization header.
const KEY_STORAGE = "hbr-chat-key";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning: string;
}

function readableError(status: number, body: { error?: { message?: string } } | null): string {
  const msg = body?.error?.message;
  if (status === 401)
    return msg ?? "Invalid API key. Paste a valid sk-hbr- key from the API keys page.";
  if (status === 402) return msg ?? "Insufficient wallet balance for this request.";
  if (status === 404) return msg ?? "Model not found. Pick another model.";
  return msg ?? `Request failed (${status}).`;
}

function appendDelta(msg: ChatMessage, delta: StreamDelta): ChatMessage {
  return {
    ...msg,
    content: msg.content + delta.content,
    reasoning: msg.reasoning + delta.reasoning,
  };
}

export function ChatPage() {
  const [apiKey, setApiKey] = React.useState("");
  const [remember, setRemember] = React.useState(false);
  const [models, setModels] = React.useState<string[]>([]);
  const [model, setModel] = React.useState("");
  const [modelsError, setModelsError] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // Key the model list was last fetched for; blur refetches only when it changed.
  const lastKeyRef = React.useRef<string>("");

  // Restore a tab-scoped remembered key once, on mount (never during SSR).
  React.useEffect(() => {
    const saved = sessionStorage.getItem(KEY_STORAGE);
    if (saved) {
      setApiKey(saved);
      setRemember(true);
    }
  }, []);

  React.useEffect(() => {
    if (remember && apiKey) sessionStorage.setItem(KEY_STORAGE, apiKey);
    else sessionStorage.removeItem(KEY_STORAGE);
  }, [remember, apiKey]);

  const loadModels = React.useCallback(async () => {
    if (!apiKey) return;
    lastKeyRef.current = apiKey;
    setModelsError(null);
    try {
      const res = await fetch("/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(readableError(res.status, body));
      }
      const body = (await res.json()) as { data: Array<{ id: string }> };
      setModels(body.data.map((m) => m.id));
      setModel((cur) =>
        cur && body.data.some((m) => m.id === cur) ? cur : (body.data[0]?.id ?? ""),
      );
    } catch (e) {
      setModels([]);
      setModel("");
      setModelsError(e instanceof Error ? e.message : "Could not load models.");
    }
  }, [apiKey]);

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    stop();
    setMessages([]);
    setError(null);
  }

  function appendToLast(delta: StreamDelta) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), appendDelta(last, delta)];
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming || !apiKey || !model) return;
    setInput("");
    setError(null);
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      ...messages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: text },
    ];
    setMessages([
      ...history.map((m) => ({ ...m, reasoning: "" })),
      { role: "assistant", content: "", reasoning: "" },
    ]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages: history, stream: true }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(readableError(res.status, body));
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Streaming is not supported in this browser.");
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          appendToLast(delta);
        }
        if (parser.done) break;
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "Request failed.");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  const canSend = Boolean(input.trim() && apiKey && model && !streaming);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Chat"
        description="Talk to published models through the paid gateway."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={newChat}
            disabled={messages.length === 0 && !streaming}
          >
            New chat
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72 space-y-1.5">
          <Label htmlFor="chat-api-key">API key</Label>
          <Input
            id="chat-api-key"
            type="password"
            autoComplete="off"
            placeholder="sk-hbr-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value.trim())}
            onBlur={() => {
              if (apiKey !== lastKeyRef.current) void loadModels();
            }}
          />
        </div>
        <div className="w-56 space-y-1.5">
          <Label htmlFor="chat-model">Model</Label>
          <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
            <SelectTrigger id="chat-model" aria-label="Model">
              <SelectValue placeholder={apiKey ? "Loading models…" : "Paste a key first"} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="chat-remember"
            checked={remember}
            onCheckedChange={setRemember}
            aria-label="Remember key for this tab"
          />
          <Label htmlFor="chat-remember" className="text-sm font-normal text-muted-foreground">
            Remember for this tab
          </Label>
        </div>
      </div>

      {modelsError && <ErrorState message={`Models: ${modelsError}`} />}
      {error && <ErrorState message={error} />}

      {messages.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="Start a conversation"
          description="Paste an API key from the API keys page above, then pick a model."
        >
          <Button asChild variant="link" className="h-auto p-0">
            {/* Plain anchor: /keys lives behind the auth route tree, and this
                page is wired into the router by a separate change. */}
            <a href="/keys">Open API keys</a>
          </Button>
        </EmptyState>
      ) : (
        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border border-border p-4"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="max-w-[80%] space-y-1">
                {m.reasoning && (
                  <div className="whitespace-pre-wrap rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    {m.reasoning}
                  </div>
                )}
                {m.content ? (
                  <div className="rounded-lg bg-muted px-3 py-1 text-sm [&_p]:my-2">
                    {renderMarkdown(m.content)}
                  </div>
                ) : (
                  !m.reasoning && <div className="text-sm text-muted-foreground">Thinking…</div>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          placeholder={
            apiKey && model
              ? "Send a message… (Enter to send, Shift+Enter for a new line)"
              : "Paste an API key and pick a model first"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // IME composition: Enter confirms the candidate, not the message.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          className="min-h-16"
        />
        {streaming ? (
          <Button variant="outline" onClick={stop} aria-label="Stop generating">
            <Square className="size-4" aria-hidden />
            Stop
          </Button>
        ) : (
          <Button onClick={() => void send()} disabled={!canSend} aria-label="Send message">
            <Send className="size-4" aria-hidden />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

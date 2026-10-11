import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CpaPanelBridge,
  type PanelConfirmation,
  type PanelProposal,
} from "../../lib/cpa-panel-bridge";
import { useT } from "../../lib/i18n/t";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

const copy = {
  title: { en: "Upstream CPA panel", vi: "Bảng điều khiển CPA upstream" },
  supported: {
    en: "Supported: auth-file list, enable/disable, named deletion, OAuth model aliases and exclusions. Every change requires confirmation here.",
    vi: "Hỗ trợ: danh sách tệp xác thực, bật/tắt, xóa theo tên, alias và loại trừ mô hình OAuth. Mọi thay đổi đều cần xác nhận tại đây.",
  },
  unsupported: {
    en: "Unavailable in this embedded panel: YAML, provider/API keys, credential upload/download/edit, OAuth sign-in, quota checks, logs and model suggestions. Use the first-party controls in the other tabs for supported configuration changes.",
    vi: "Không hỗ trợ trong bảng nhúng: YAML, key nhà cung cấp/API, tải lên/tải xuống/sửa credential, đăng nhập OAuth, kiểm tra quota, nhật ký và gợi ý mô hình. Dùng các điều khiển của HoboRouter ở tab khác để thay đổi cấu hình được hỗ trợ.",
  },
  loading: { en: "Loading isolated panel…", vi: "Đang tải bảng điều khiển cách ly…" },
  unavailable: {
    en: "Panel unavailable or admin session expired. Reload to reconnect; no change is retried automatically.",
    vi: "Bảng điều khiển không khả dụng hoặc phiên quản trị đã hết hạn. Tải lại để kết nối; không tự động thử lại thay đổi.",
  },
  reload: { en: "Reload panel", vi: "Tải lại bảng điều khiển" },
  confirmTitle: { en: "Confirm CPA change", vi: "Xác nhận thay đổi CPA" },
  warning: {
    en: "Review the server-validated change below. It affects live CPA state. Deletion cannot be undone; an empty alias or exclusion list clears that group.",
    vi: "Kiểm tra thay đổi đã được máy chủ xác thực bên dưới. Thay đổi ảnh hưởng trạng thái CPA đang chạy. Không thể hoàn tác việc xóa; danh sách alias hoặc loại trừ rỗng sẽ xóa nhóm đó.",
  },
  setAuthFileStatus: { en: "Change auth-file status", vi: "Thay đổi trạng thái tệp xác thực" },
  deleteAuthFiles: { en: "Delete named auth files", vi: "Xóa các tệp xác thực theo tên" },
  replaceModelAliases: { en: "Replace model aliases", vi: "Thay thế alias mô hình" },
  replaceModelExclusions: { en: "Replace model exclusions", vi: "Thay thế mô hình loại trừ" },
  cancel: { en: "Cancel", vi: "Hủy" },
  confirm: { en: "Confirm", vi: "Xác nhận" },
} as const;
const sessionSchema = z.object({ csrf_token: z.string().min(1).max(256) }).strict();

function ProposalDetails({ proposal }: { proposal: PanelProposal }) {
  return (
    <pre
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs"
      tabIndex={0}
    >
      {JSON.stringify(proposal.args, null, 2)}
    </pre>
  );
}

export function CpaIsolatedPanel() {
  const t = useT(copy);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CpaPanelBridge | null>(null);
  const csrfRef = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmation, setConfirmation] = useState<PanelConfirmation | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const revoke = () => {
      if (!active) return;
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      csrfRef.current = null;
      setReady(false);
      setUnavailable(true);
    };
    setReady(false);
    setUnavailable(false);
    const timeout = setTimeout(() => {
      controller.abort();
      revoke();
    }, 10000);
    const receive = (event: MessageEvent<unknown>) => bridgeRef.current?.handle(event);
    window.addEventListener("message", receive);
    void (async () => {
      try {
        const response = await fetch("/api/v1/admin/cpa/panel/session", {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("session unavailable");
        const session = sessionSchema.parse(await response.json());
        if (!active || controller.signal.aborted) return;
        clearTimeout(timeout);
        csrfRef.current = session.csrf_token;
        setReady(true);
        // Backend expiry/revocation is authoritative; this also bounds an idle frame's lifetime.
        expiry = setTimeout(revoke, 30 * 60 * 1000);
      } catch {
        revoke();
      }
    })();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      clearTimeout(expiry);
      window.removeEventListener("message", receive);
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      csrfRef.current = null;
    };
  }, [reload]);

  const loaded = () => {
    bridgeRef.current?.dispose();
    bridgeRef.current = null;
    const frame = frameRef.current?.contentWindow;
    const csrf = csrfRef.current;
    if (!frame || !csrf) return;
    const bridge = new CpaPanelBridge({
      frame,
      csrf,
      channel: crypto.randomUUID(),
      onProposal: setConfirmation,
      onUnavailable: () => {
        csrfRef.current = null;
        setReady(false);
        setUnavailable(true);
      },
    });
    bridgeRef.current = bridge;
    bridge.init();
  };

  return (
    <section aria-label={t("title")} className="space-y-3">
      <div className="space-y-1 text-sm">
        <h2 className="font-medium">{t("title")}</h2>
        <p>{t("supported")}</p>
        <p className="text-muted-foreground">{t("unsupported")}</p>
      </div>
      {unavailable ? (
        <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
          <p>{t("unavailable")}</p>
          <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>
            {t("reload")}
          </Button>
        </div>
      ) : ready ? (
        <iframe
          key={reload}
          ref={frameRef}
          title={t("title")}
          src="/api/v1/admin/cpa/panel/management.html#/auth-files"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          onLoad={loaded}
          className="h-[calc(100dvh-22rem)] min-h-96 w-full rounded-md border"
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      )}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) confirmation?.cancel();
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("warning")}</DialogDescription>
          </DialogHeader>
          {confirmation && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t(confirmation.proposal.operation)}</p>
              <ProposalDetails proposal={confirmation.proposal} />
            </div>
          )}
          <DialogFooter>
            <Button ref={cancelRef} variant="outline" onClick={() => confirmation?.cancel()}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={() => confirmation?.confirm()}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

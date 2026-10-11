// Public FAQ page: bilingual (EN/VI) Q&A rendered as a native <details>
// accordion (free keyboard/AT contract, no accordion dependency). Same
// embedded/PublicLayout contract as About: signed-in users get the bare body
// inside the AppShell; anonymous visitors get the full public chrome.
// The MCP answer documents the real architecture boundary (OpenAI-compatible
// passthrough, no MCP client/server) — it never advertises protocol support
// that does not exist.
import { PageHeader } from "../../components/page";
import { PublicLayout } from "../../components/public-layout";
import { SupportLinks, supportLinks } from "../../components/support-links";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { usePublicInstance, type PublicInstance } from "../../lib/public-queries";
import { useShellSession } from "../../lib/session";

const faqTitle: LocaleEntry = { en: "Frequently asked questions", vi: "Câu hỏi thường gặp" };
const faqDescription: LocaleEntry = {
  en: "Short answers about billing, the API, the built-in chat and support.",
  vi: "Câu trả lời ngắn về thanh toán, API, chat tích hợp và hỗ trợ.",
};
const noContact: LocaleEntry = {
  en: "No contact channels are configured on this instance yet.",
  vi: "Instance này chưa cấu hình kênh liên hệ nào.",
};

interface FaqEntry {
  q: LocaleEntry;
  a: LocaleEntry;
}

// One entry per question; code identifiers (MCP, OpenAI, tools/tool_choice)
// and numbers stay verbatim across locales.
const FAQ_ENTRIES: FaqEntry[] = [
  {
    q: { en: "What is Hoborouter?", vi: "Hoborouter là gì?" },
    a: {
      en: "Hoborouter is an OpenAI-compatible gateway in front of multiple AI providers. You talk to one API (the /v1 endpoints) with one API key, and Hoborouter routes each request to the model you picked and bills usage per token.",
      vi: "Hoborouter là cổng API tương thích OpenAI phía trước nhiều nhà cung cấp AI. Bạn gọi một API duy nhất (các endpoint /v1) với một API key, Hoborouter chuyển mỗi request đến model bạn chọn và tính phí theo từng token.",
    },
  },
  {
    q: { en: "How is usage billed?", vi: "Mức sử dụng được tính phí như thế nào?" },
    a: {
      en: "Everything is billed in VND from your workspace wallet. Each request is reserved before it runs and settled afterwards; the ledger keeps an append-only history of every top-up, charge and refund. See Usage for per-request detail.",
      vi: "Mọi thứ được tính bằng VND từ ví của workspace. Mỗi request được đặt trước trước khi chạy và tất toán sau đó; sổ cái ghi lịch sử chỉ-append của mọi lần nạp, tính phí và hoàn tiền. Xem Usage để biết chi tiết từng request.",
    },
  },
  {
    q: { en: "How do I make my first API call?", vi: "Làm sao gọi API đầu tiên?" },
    a: {
      en: "Create an account, top up credits, create an API key, then follow the Quickstart for copy-pasteable curl and OpenAI SDK examples.",
      vi: "Tạo tài khoản, nạp tín dụng, tạo API key, sau đó làm theo Quickstart với các ví dụ curl và OpenAI SDK copy-paste được.",
    },
  },
  {
    q: { en: "Can I attach files in the built-in Chat?", vi: "Có thể đính kèm tệp trong Chat không?" },
    a: {
      en: "Yes: images (PNG, JPEG, WebP, GIF up to 10 MB each) and text/code files (up to 64 KB each), at most 4 files and 10 MB total per message. Attachments live only in the current browser session — they are sent with the message but are not stored in your conversation history.",
      vi: "Có: ảnh (PNG, JPEG, WebP, GIF, tối đa 10 MB mỗi ảnh) và tệp văn bản/mã nguồn (tối đa 64 KB mỗi tệp), tối đa 4 tệp và 10 MB mỗi tin nhắn. Tệp đính kèm chỉ tồn tại trong phiên trình duyệt hiện tại — chúng được gửi cùng tin nhắn nhưng không được lưu vào lịch sử hội thoại.",
    },
  },
  {
    q: {
      en: "Does Hoborouter support MCP (Model Context Protocol)?",
      vi: "Hoborouter có hỗ trợ MCP (Model Context Protocol) không?",
    },
    a: {
      en: "Not today. The gateway is a thin OpenAI-compatible passthrough: it forwards standard OpenAI request fields — including tools and tool_choice for function calling — to providers that support them, but it does not act as an MCP client or MCP server, and there is no local MCP seam in the web app. If you need MCP tools, run a translator that exposes them over the OpenAI tool-calling shape (for example mcpo) and point its OpenAI-compatible endpoint at this gateway. Browser-based MCP is not possible anyway: the stdio transport requires a local subprocess.",
      vi: "Chưa hỗ trợ. Cổng API là lớp passthrough tương thích OpenAI mỏng: nó chuyển tiếp các trường chuẩn của OpenAI — kể cả tools và tool_choice cho function calling — đến các nhà cung cấp hỗ trợ, nhưng không đóng vai trò MCP client hay MCP server, và web app không có điểm nối MCP cục bộ. Nếu cần công cụ MCP, hãy chạy một bộ chuyển đổi phơi chúng qua dạng tool-calling của OpenAI (ví dụ mcpo) rồi trỏ endpoint tương thích OpenAI của nó vào gateway này. MCP trong trình duyệt vốn không khả thi: transport stdio cần tiến trình con cục bộ.",
    },
  },
  {
    q: { en: "How do I get help?", vi: "Làm sao để được hỗ trợ?" },
    a: {
      en: "Use one of the contact channels below, or open the About page for instance details. Support replies to the address or handle shown.",
      vi: "Dùng một trong các kênh liên hệ bên dưới, hoặc mở trang Giới thiệu để xem thông tin instance. Hỗ trợ sẽ trả lời qua địa chỉ hoặc tài khoản hiển thị.",
    },
  },
];

/** One Q&A row; component boundary keeps useLocaleEntry per-element so the
 *  locale flip re-renders each answer (same pattern as PromptChip in chat). */
function FaqItem({ entry }: { entry: FaqEntry }) {
  const q = useLocaleEntry(entry.q);
  const a = useLocaleEntry(entry.a);
  return (
    <details className="rounded-md border border-border px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium">{q}</summary>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</p>
    </details>
  );
}

export function Faq({ instance, embedded }: { instance?: PublicInstance | null; embedded?: boolean }) {
  const title = useLocaleEntry(faqTitle);
  const description = useLocaleEntry(faqDescription);
  const noContactText = useLocaleEntry(noContact);
  const contact = useLocaleEntry({ en: "Contact", vi: "Liên hệ" });
  const hasContact = supportLinks(instance?.support).length > 0;
  const body = (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-6">
      <PageHeader title={title} description={description} />
      <div className="space-y-2">
        {FAQ_ENTRIES.map((e) => (
          <FaqItem key={e.q.en} entry={e} />
        ))}
      </div>
      <section aria-labelledby="faq-contact-heading" className="space-y-2">
        <h2 id="faq-contact-heading" className="text-lg font-semibold">
          {contact}
        </h2>
        <div className="text-sm">
          <SupportLinks support={instance?.support} />
          {!hasContact && <p className="text-muted-foreground">{noContactText}</p>}
        </div>
      </section>
    </div>
  );
  if (embedded) return body;
  return <PublicLayout instance={instance}>{body}</PublicLayout>;
}

export default function FaqPage() {
  const instance = usePublicInstance();
  const { data: session } = useShellSession();
  return <Faq instance={instance.data ?? null} embedded={!!session} />;
}

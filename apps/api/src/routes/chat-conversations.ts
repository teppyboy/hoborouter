// Thin alias: the canonical chat-history routes live in ./chats.ts (tested by
// apps/api/test/chats.test.ts and apps/api/test/chat-conversations.test.ts).
// This module remains only so existing imports keep resolving to the SAME
// implementation — never a second route tree on the same paths.
import { chatsRoutes } from "./chats";

export const chatConversationsRoutes = chatsRoutes;

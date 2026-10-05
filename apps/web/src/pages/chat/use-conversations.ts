// React-query bindings over the chat conversations client. Session user id and
// current workspace id are part of every query key: switching either clears
// the display, and a response from an old identity can never land under the
// new one. Saving never fakes success — a 409 surfaces to the caller, which
// reloads the server snapshot instead of overwriting.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../lib/auth";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import {
  createConversation,
  getConversation,
  listConversations,
  saveConversation,
  archiveConversation,
  type SaveConversationInput,
  type ConversationSnapshot,
} from "./conversations";

const conversationsKey = (userId: string, workspaceId: string) => [
  "chat-conversations",
  userId,
  workspaceId,
];

export function useConversations() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? "";
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: conversationsKey(userId, workspaceId),
    queryFn: () => listConversations(workspaceId),
    // Only fetch for a fully-resolved identity; avoids 401/403 noise during
    // logout/login or workspace switches.
    enabled: userId !== "" && workspaceId !== "",
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: conversationsKey(userId, workspaceId) });

  const create = useMutation({
    mutationFn: () => createConversation(workspaceId),
    onSuccess: invalidate,
  });

  const save = useMutation({
    // Resolves with the SERVER snapshot (version already incremented).
    // Rejects ConversationError("conflict") on a stale version — the caller
    // must reload, never retry blindly.
    mutationFn: ({ chatId, input }: { chatId: string; input: SaveConversationInput }) =>
      saveConversation(workspaceId, chatId, input),
    onSuccess: invalidate,
  });

  const archive = useMutation({
    mutationFn: (chatId: string) => archiveConversation(workspaceId, chatId),
    onSuccess: invalidate,
  });

  const load = (chatId: string) => getConversation(workspaceId, chatId);

  return {
    // undefined while identity is resolving; empty page when loaded.
    list,
    create,
    save,
    archive,
    load,
  };
}

export type { ConversationSnapshot };

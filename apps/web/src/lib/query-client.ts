import { QueryClient } from "@tanstack/react-query";

/** Module-level client so auth transitions can clear all cached queries. */
export const queryClient = new QueryClient();

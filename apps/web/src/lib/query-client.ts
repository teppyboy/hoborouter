import { QueryClient, keepPreviousData } from "@tanstack/react-query";

/** Module-level client so auth transitions can clear all cached queries. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Revisits show cached data instantly; refetch happens in background.
      staleTime: 30_000,
      // Skip refetch storms while data is fresh.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      // Paginated/filterable lists keep previous rows instead of skeletons.
      placeholderData: keepPreviousData,
    },
  },
});

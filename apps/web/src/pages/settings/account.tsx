import { useSession } from "../../lib/auth";
import { signOut } from "../../lib/auth";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

export default function AccountTab() {
  const { data: session, isPending } = useSession();

  if (isPending) return <Skeleton className="h-24 w-full max-w-md" />;

  return (
    <div className="max-w-md">
      <dl className="grid gap-3 text-sm">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-mono">{session?.user?.email ?? "—"}</dd>
        </div>
        <div className="flex items-center justify-between border-b border-border pb-2">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{session?.user?.name ?? "—"}</dd>
        </div>
      </dl>
      <Button
        variant="outline"
        size="sm"
        className="mt-6"
        onClick={() => signOut()}
      >
        Sign out
      </Button>
    </div>
  );
}

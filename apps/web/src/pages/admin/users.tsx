import { EmptyState, PageHeader } from "../../components/page";

export default function AdminUsersPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Instance users." />
      <EmptyState
        title="Not available yet"
        description="User management needs a backend endpoint (GET /api/admin/users) that does not exist yet."
      />
    </div>
  );
}

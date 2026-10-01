import { EmptyState, PageHeader } from "../../components/page";

export default function AdminPaymentsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description="Pending top-up payments." />
      <EmptyState
        title="Not available yet"
        description="Payment administration needs backend endpoints (GET /api/admin/payments, POST /api/admin/payments/:id/complete) that do not exist yet."
      />
    </div>
  );
}

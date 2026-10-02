> Template — review with a lawyer before production.

<!--
Placeholders are filled from Vite env vars:
  VITE_LEGAL_OPERATOR_NAME, VITE_LEGAL_CONTACT_EMAIL, VITE_LEGAL_EFFECTIVE_DATE
-->

# Terms of Service

**Operator:** {{OPERATOR_NAME}}
**Contact:** {{CONTACT_EMAIL}}
**Effective date:** {{EFFECTIVE_DATE}}

These Terms of Service ("Terms") govern your access to and use of Hoborouter, an
OpenAI-compatible API gateway operated by {{OPERATOR_NAME}}. By creating an
account or using the service, you agree to these Terms.

## 1. Acceptance

By signing up for an account, using an API key issued by the service, or
otherwise accessing the service, you accept these Terms. If you do not agree,
do not use the service.

## 2. Who may use the service

You must be at least 16 years old and able to form a binding contract. If you
use the service on behalf of an organization, you represent that you are
authorised to bind that organization to these Terms.

## 3. Accounts and workspaces

The service uses email and password accounts. Sessions are maintained with
cookies. You are responsible for keeping your credentials secure and for all
activity under your account.

Accounts are organised into workspaces. Each workspace has members with roles
that control access to workspace resources such as API keys, logs, and billing.
Workspace administrators are responsible for the members they invite and the
roles they assign.

## 4. API keys

The service issues API keys for programmatic access. Keys are stored hashed;
the full plaintext key is displayed only once at creation. You must store your
keys securely, never share or publish them, and delete and regenerate any key
you suspect has been compromised. All usage authenticated by your key is billed
to your workspace and is your responsibility.

## 5. Acceptable use

You must not use the service to:

- break any applicable law or regulation, including those of Vietnam;
- generate or distribute content that is illegal, harmful, or that infringes
  the rights of others;
- abuse, overload, or attempt to disrupt the service or its infrastructure;
- resell, sublicense, or share API keys or access with unauthorised parties;
- circumvent rate limits, quotas, or billing controls;
- violate the acceptable-use policies of the upstream model providers the
  service forwards requests to.

We may suspend or terminate accounts that violate these rules.

## 6. Prepaid credits and billing

The service operates on prepaid credits:

- Model prices are listed in **US dollars per 1 million tokens**.
- You top up credits in **Vietnamese đồng (VND)**. Top-ups are converted to
  service credits using the USD→VND exchange rate configured by the operator
  at the time of the transaction.
- Each request is charged based on the token usage **reported by the upstream
  provider** for that request, at the published per-model price.
- When a request is dispatched, a hold is reserved against your balance. If a
  request fails or is aborted after dispatch, the **full hold is charged**,
  because upstream providers may have processed the request.
- Credits are **non-refundable**, except where a refund is required by
  applicable law or granted at the operator's discretion.
- Credits do not earn interest.

Payments are processed through third-party payment providers. Payment records
are retained for accounting and dispute purposes.

## 7. Third-party model providers

Requests are forwarded to third-party model providers. Outputs are generated
by those third parties:

- We make **no warranty** on the accuracy, completeness, or fitness of any
  model output. You are responsible for reviewing outputs before relying on
  them.
- Provider availability can change without notice.
- Models may be added, removed, or replaced. Model **prices may change with
  prior notice** on the pricing page before the change takes effect.

## 8. Availability

The service is provided as-is. We aim for reliable operation but do not offer
a service-level agreement (SLA) or guaranteed uptime. Maintenance and upstream
provider outages may interrupt service.

## 9. Suspension and termination

We may suspend or terminate your access if you breach these Terms, fail to
maintain sufficient balance, or as required by law. You may stop using the
service and request account deletion at any time via {{CONTACT_EMAIL}}.
On termination, remaining credits are non-refundable except as described in
Section 6 or where required by law.

## 10. Disclaimers and limitation of liability

The service (including all outputs and content) is provided "as is" and "as
available" without warranties of any kind, to the maximum extent permitted by
law. To the maximum extent permitted by applicable law, {{OPERATOR_NAME}}
is not liable for indirect, incidental, special, consequential, or punitive
damages, or for lost profits, data, or business opportunities. Our aggregate
liability for any claim is limited to the amount you paid us for the service
in the six (6) months preceding the claim.

## 11. Changes to these Terms

We may update these Terms. Material changes will be announced (for example, on
the website or by email) before they take effect. Continued use after the
effective date constitutes acceptance of the updated Terms.

## 12. Governing law

These Terms are governed by the laws of **Vietnam**. Disputes are subject to
the jurisdiction of the competent courts of Vietnam.

## 13. Contact

Questions about these Terms: **{{CONTACT_EMAIL}}**.

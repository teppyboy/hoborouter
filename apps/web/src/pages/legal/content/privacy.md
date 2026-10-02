# Privacy Policy

**Operator:** Hoborouter Team
**Contact:** hoborouter@june8th.me
**Effective date:** 2026-10-02

This Privacy Policy explains how Hoborouter Team ("we") collects, uses,
and protects personal data when you use Hoborouter, our OpenAI-compatible API
gateway.

## 1. What we collect

**Account data:** name (if provided), email address, and a password hash
(we never store your plaintext password).

**Session data:** sign-in sessions are kept in cookies. Session records may
store your IP address and browser user-agent string.

**Workspace data:** workspaces you create or belong to, member lists, and the
roles assigned to you.

**API key metadata:** hashed API keys, a short key prefix for identification,
key names, and creation/revocation status. Plaintext keys are shown once at
creation and are not stored.

**Usage metadata:** for each request we store the model, provider, token counts
(input, output, cached, reasoning), HTTP status, failure reason, latency,
computed cost, the applied USD→VND exchange rate, and the API key used. We do
**not** store the content of your prompts or the model's responses — request
and response bodies are forwarded to the upstream provider and discarded. We
also do not store the full text of API keys.

**Payment records:** top-up amounts, payment provider references, and webhook
payloads, retained for accounting and dispute handling.

**Audit logs:** records of administrative and account actions (who did what
and when) for security and accountability.

**Browser storage:** the web app uses one session cookie and browser
localStorage for non-identifying preferences (theme and selected workspace).

## 2. What we do not store

To be explicit, the service does **not** retain:

- the text of your prompts or the model's completions;
- your plaintext password or plaintext API keys.

## 3. How prompts are processed

Your API requests are forwarded to upstream third-party model providers
through our gateway infrastructure. Those providers receive and process your
request content (including prompts) under **their own** privacy policies and
terms. We do not store that content, but you should review the applicable
policies of the providers you use and avoid sending personal or sensitive data
in prompts when it is not necessary.

## 4. Purposes of processing

We process personal data to: operate the service and authenticate you; meter,
bill, and collect payment for usage; secure the service (audit logs, abuse
detection); provide support; and comply with legal obligations.

## 5. Sharing

We share personal data only with:

- **Upstream AI providers**, who receive your request content to generate
  responses;
- **Payment processors**, who handle top-up transactions;
- **Cloudflare** (Turnstile bot protection), only when enabled on login;
- **Hosting/infrastructure providers** as needed to run the service;
- Authorities where required by applicable law.

We do not sell personal data.

## 6. Retention

Account and workspace data are kept while your account is active. Usage and
payment records are retained as required for accounting and dispute resolution.
Audit logs are retained for security purposes. You may request deletion of
your account data (Section 8); some records may be retained where legally
required.

## 7. Security

We hash passwords and API keys, expose the gateway's upstream proxy only on a
loopback/internal interface, restrict plaintext API key display to creation
time, and log administrative actions. No system is perfectly secure; please
use strong passwords and protect your keys.

## 8. Your rights

Under Vietnam's **Personal Data Protection Decree 13/2023/ND-CP**, you have
rights regarding your personal data, which we support, including the right to:

- be informed about the processing of your data;
- **access** your data;
- request **correction** of inaccurate data;
- request **deletion** of your data (subject to legal retention
  requirements);
- **withdraw consent** to processing where processing is based on consent;
- complain about data processing.

To exercise any right, contact hoborouter@june8th.me. We may need to verify
your identity before acting on a request.

## 9. Children

The service is not directed at, and may not be used by, children under
**16 years of age**.

## 10. International transfers

Upstream model providers and some service providers may be located outside
Vietnam, so your data (including request content) may be transferred and
processed abroad. By using the service, you acknowledge these transfers. We
aim to work with providers that offer appropriate data protection.

## 11. Changes to this policy

We may update this Privacy Policy. Changes will be posted on this page with an
updated effective date.

## 12. Contact

Privacy questions and requests: **hoborouter@june8th.me**.

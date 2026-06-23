---
last_updated: "2026-01-22"
description: "Comprehensive reference for HubSpot API covering CRM, Marketing, Sales, Commerce, Analytics, and cross-cutting platform behaviors."
generated_by: skills/documentation/write-deep-dive-as-doc/SKILL.md
generated_date: 260122
---

# HubSpot API Deep Dive

## See Also

- [Official API Documentation](https://developers.hubspot.com/docs) - Complete API reference
- [API Changelog](https://developers.hubspot.com/changelog) - Latest updates and breaking changes
- [Usage Guidelines & Rate Limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines) - Rate limiting and quotas
- [Date-Based Versioning (Beta)](https://developers.hubspot.com/docs/guides/dbv/overview) - New `2025-09` style versioning
- [HUBSPOT_MCP.md](./HUBSPOT_MCP.md) - Our MCP implementation and tools

---

## 1. Authentication & Platform Fundamentals

### Authentication Models

| Model | Use Case | Notes |
|-------|----------|-------|
| **Private App Token** | Single account integrations | `Authorization: Bearer <token>`, recommended for most cases |
| **OAuth 2.0** | Multi-account / Marketplace apps | Required for distribution, scopes matter |
| **Developer API Key (`hapikey`)** | Legacy admin endpoints | Still used for some Webhooks v3 settings |

### Rate Limits (Updated 2026-01)

**Private Apps (per app, per account):**

| Tier | Burst (per 10s) | Daily Limit |
|------|-----------------|-------------|
| Free/Starter | 100 | 250,000 |
| Professional | 190 | 625,000 |
| Enterprise | 190 | 1,000,000 |
| + API Limit Add-on | +250 | +1,000,000 (max 2 packs) |

**Public OAuth Apps:** 110 / 10s per installing account (add-on doesn't increase this)

**Special Limits:**
- **CRM Search API** has stricter, separate limits
- **Webhooks deliveries** don't count against API rate limits
- **Events API:** 1,250 req/sec for send endpoint

### API Versioning

**Two versioning systems exist:**

1. **Developer Platform Versioning** (`platformVersion` in `hsproject.json`)
   - GA releases: **March** and **September** (e.g., `2025.2`)
   - Lifecycle: 6 months Current + 12 months Supported = 18 months total

2. **Date-Based Versioned APIs (Beta)**
   - Endpoint paths include date: `/2025-09/crm/v3/objects/...`
   - Currently applies to: Account Info, Associations, CRM Objects, Properties
   - ≥18 months support window, immutable

---

## 2. CRM APIs (Core Objects)

All CRM objects follow a consistent pattern at `/crm/v3/objects/{objectType}`.

### Standard Operations

| Operation | Method | Endpoint | Notes |
|-----------|--------|----------|-------|
| List | GET | `/crm/v3/objects/{type}` | Pagination via `after` |
| Get | GET | `/crm/v3/objects/{type}/{id}` | Add `?properties=` for specific fields |
| Search | POST | `/crm/v3/objects/{type}/search` | Filter groups, sorting, pagination |
| Create | POST | `/crm/v3/objects/{type}` | `{ properties: {...} }` |
| Update | PATCH | `/crm/v3/objects/{type}/{id}` | `{ properties: {...} }` |
| Delete | DELETE | `/crm/v3/objects/{type}/{id}` | Soft delete (archived) |
| Batch | POST | `/crm/v3/objects/{type}/batch/{operation}` | `create`, `update`, `read`, `archive` |

### Object Types & Scopes

| Object | Type String | Read Scope | Write Scope |
|--------|-------------|------------|-------------|
| Contacts | `contacts` | `crm.objects.contacts.read` | `crm.objects.contacts.write` |
| Companies | `companies` | `crm.objects.companies.read` | `crm.objects.companies.write` |
| Deals | `deals` | `crm.objects.deals.read` | `crm.objects.deals.write` |
| Tickets | `tickets` | `tickets` | `tickets` |
| Tasks | `tasks` | - | - |
| Notes | `notes` | - | - |
| Calls | `calls` | - | - |
| Emails | `emails` | - | - |
| Meetings | `meetings` | - | - |
| Products | `products` | `crm.objects.products.read` | `crm.objects.products.write` |
| Line Items | `line_items` | `crm.objects.line_items.read` | `crm.objects.line_items.write` |
| Invoices | `invoices` | `crm.objects.invoices.read` | `crm.objects.invoices.write` |

### Search API Filters

```json
{
  "filterGroups": [{
    "filters": [
      { "propertyName": "email", "operator": "EQ", "value": "john@example.com" },
      { "propertyName": "lifecyclestage", "operator": "IN", "values": ["lead", "customer"] }
    ]
  }],
  "sorts": [{ "propertyName": "createdate", "direction": "DESCENDING" }],
  "properties": ["email", "firstname", "lastname"],
  "limit": 10,
  "after": 0
}
```

**Operators:** `EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE`, `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN`, `IN`, `NOT_IN`, `HAS_PROPERTY`, `NOT_HAS_PROPERTY`, `BETWEEN`

### Associations

```
GET  /crm/v3/objects/{fromType}/{id}/associations/{toType}
PUT  /crm/v3/objects/{fromType}/{id}/associations/{toType}/{toId}/{associationType}
DELETE /crm/v3/objects/{fromType}/{id}/associations/{toType}/{toId}/{associationType}
```

Common association types: `contact_to_company`, `deal_to_contact`, `deal_to_company`, `ticket_to_contact`, `note_to_contact`

### Pipelines & Stages

```
GET /crm/v3/pipelines/{objectType}
GET /crm/v3/pipelines/{objectType}/{pipelineId}
```

Returns pipeline IDs and stage IDs needed for creating deals/tickets with proper stage values.

### Owners

```
GET /crm/v3/owners
GET /crm/v3/owners/{ownerId}
```

Returns owner IDs needed for `hubspot_owner_id` property assignments.

---

## 3. Analytics & Reporting APIs

### Analytics v2 (Traffic Reports)

**Endpoint Pattern:**
```
GET /analytics/v2/reports/{breakdown_by}/{time_period}?start=YYYYMMDD&end=YYYYMMDD
```

**Breakdown Options:**
| Breakdown | Description |
|-----------|-------------|
| `totals` | Overall totals |
| `sessions` | Session data |
| `sources` | Traffic by source (organic, direct, social, etc.) |
| `geolocation` | Traffic by country/region |
| `utm-campaigns` | Campaign attribution |
| `utm-sources` | UTM source breakdown |
| `utm-mediums` | UTM medium breakdown |
| `pages` | Page-level analytics |

**Time Periods:** `totals`, `daily`, `weekly`, `monthly`

**Query Parameters:**
- `start`, `end`: Date range in `YYYYMMDD` format
- `d1`, `d2`: Drilldown dimensions
- `f`: Filter (repeatable)
- `sort`: Sort field (descending)

**Response Metrics:**
- `rawViews`, `visits`, `visitors`
- `leads`, `customers`
- `bounceRate`, `avgTimeOnPage`
- `newVisitorSessionRate`

**Scope Required:** `content`

**Tier Requirement:** Marketing Hub

### Events API v3 (Behavioral Analytics)

**⚠️ Enterprise Only**

**Query Events:**
```
GET /events/v3/events?objectType=contact&objectId={id}
GET /events/v3/events?objectType=contact&objectProperty.email={email}
```

**Filter by Event Type:**
```
GET /events/v3/events?eventType={EVENT_NAME}
```

**List Event Types:**
```
GET /events/v3/events/event-types
```

**Send Custom Events:**
```
POST /events/v3/send
{
  "eventName": "pe{HubID}_{event_name}",
  "objectId": "123",
  "occurredAt": "2026-01-22T10:00:00Z",
  "properties": { "key": "value" }
}
```

**Scopes:**
- Query: `behavioral_events.event_definitions.read_write`
- Send: `analytics.behavioral_events.send`

**Limits:**
- 500 event definitions per account
- 30 million events/month
- 1,250 requests/second for send endpoint
- 50 properties per event

### Email Analytics v1 (Legacy)

```
GET /email/public/v1/events?recipient={email}&eventType={type}
```

**Event Types:** `SENT`, `DELIVERED`, `OPEN`, `CLICK`, `BOUNCE`, `UNSUBSCRIBE`, `SPAMREPORT`

**Query Parameters:**
- `recipient`: Filter by email address
- `campaignId`: Filter by campaign
- `eventType`: Filter by event type
- `startTimestamp`, `endTimestamp`: Date range (Unix ms)
- `limit`: Max 1000

**Scope:** `content`

---

## 4. Marketing APIs

### Marketing Emails v3

```
GET  /marketing/v3/emails
GET  /marketing/v3/emails/{emailId}
POST /marketing/v3/emails
```

**Create Email:**
```json
{
  "name": "Welcome Email",
  "subject": "Welcome to {{company_name}}",
  "templatePath": "@hubspot/templates/marketing-email"
}
```

**Stats Available:**
Response includes `stats` object with performance metrics (matches in-app "Performance" view).

**Scopes:** `content`, `marketing-email`, or `transactional-email`

**Note:** `/publish` and `/unpublish` require Marketing Hub Enterprise or Transactional Email add-on.

### Forms v3

```
GET  /marketing/v3/forms
GET  /marketing/v3/forms/{formGuid}
POST /marketing/v3/forms
```

**Get Form Submissions:**
```
GET /form-integrations/v1/submissions/forms/{formGuid}
```

**Scope:** `forms`

### Campaigns v3

```
GET  /marketing/v3/campaigns
GET  /marketing/v3/campaigns/{campaignGuid}
GET  /marketing/v3/campaigns/{campaignGuid}/reports/metrics
```

**Campaign Metrics:**
- Influenced contacts
- New contacts (first/last touch)
- Sessions generated

**Scope:** `marketing.campaigns.read`

**Tier:** Marketing Hub Professional+

### Subscription Preferences v4

```
GET /communication-preferences/v4/status/{email}
POST /communication-preferences/v4/subscribe
POST /communication-preferences/v4/unsubscribe
```

**Scopes:**
- `communication_preferences.read`
- `communication_preferences.write`
- `communication_preferences.read_write`

---

## 5. Sales APIs

### Products v3

```
POST /crm/v3/objects/products/search
GET  /crm/v3/objects/products/{productId}
POST /crm/v3/objects/products
```

**Common Properties:**
- `name`, `description`
- `price`, `hs_sku`, `hs_cost_of_goods_sold`
- `hs_recurring_billing_period` (for recurring products)

**Scopes:** `crm.objects.products.read`, `crm.objects.products.write`

### Line Items v3

Line items connect products to deals, quotes, invoices.

```
POST /crm/v3/objects/line_items
```

**Create with Association:**
```json
{
  "properties": {
    "name": "Product A",
    "quantity": "2",
    "price": "100"
  },
  "associations": [{
    "to": { "id": "deal_id" },
    "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 20 }]
  }]
}
```

**Scopes:** `crm.objects.line_items.read`, `crm.objects.line_items.write`

### Sequences v4

```
GET /automation/v4/sequences
POST /automation/v4/sequences/{sequenceId}/enrollments
```

**Scopes:**
- `automation.sequences.read`
- `automation.sequences.enrollments.write`

**Limit:** 1,000 enrollments per portal per day

### Quotes

HubSpot has newer CPQ quote APIs alongside legacy quotes. Check current documentation for the recommended approach.

---

## 6. Commerce APIs

### Invoices v3

```
POST /crm/v3/objects/invoices
GET  /crm/v3/objects/invoices/{invoiceId}
POST /crm/v3/objects/invoices/search
```

**Create Draft Invoice:**
```json
{
  "properties": {
    "hs_currency": "USD"
  }
}
```

**To Make Payable:**
1. Associate at least one contact
2. Associate at least one line item
3. Set `hs_invoice_status` to `open`

**Scopes:** `crm.objects.invoices.read`, `crm.objects.invoices.write`

**Tier:** Commerce Hub

### Payments v3 (External Revenue Tracking)

```
POST /crm/v3/objects/commerce_payments
```

**Purpose:** Track external revenue (not for processing HubSpot/Stripe payments)

**Required Properties:**
- `hs_initial_amount`
- `hs_initiated_date`

**Note:** Payments created via HubSpot's native processing cannot be modified/deleted via API.

**Scopes:** `crm.objects.commercepayments.read`, `crm.objects.commercepayments.write`

### Commerce Subscriptions v3

**Workflow:**
1. Create line item
2. Create subscription
3. Associate subscription ↔ line item via Associations v4
4. Optionally set `hs_invoice_creation=on` for auto-invoicing

**Lifecycle Endpoints:**
```
POST /payments-subscriptions/v1/subscriptions/{id}/pause
POST /payments-subscriptions/v1/subscriptions/{id}/unpause
POST /payments-subscriptions/v1/subscriptions/{id}/cancel
```

---

## 7. Bulk Data Operations

### Imports v3

```
POST /crm/v3/imports
GET  /crm/v3/imports/{importId}
```

**Request:** Multipart form-data with `importRequest` JSON + `files`

**Limits:**
- 80 million rows per day
- Per file: 1,048,576 rows OR 512 MB (whichever first)

**Scope:** `crm.import`

### Exports v3

```
POST /crm/v3/exports/export/async
GET  /crm/v3/exports/export/async/tasks/{exportId}/status
```

**Export Types:** `VIEW` (saved view) or `LIST` (static list)

**Limits:**
- 30 exports per rolling 24 hours
- One export at a time
- Download URL expires in 5 minutes

**Scope:** `crm.export` (OAuth install requires Super Admin to grant)

---

## 8. Webhooks v3

### Setup & Subscriptions

```
GET/PUT /webhooks/v3/{appId}/settings
GET/POST/DELETE /webhooks/v3/{appId}/subscriptions
```

**Note:** Settings endpoints use `hapikey`, not OAuth token.

### Event Types

| Category | Events |
|----------|--------|
| Contacts | `contact.creation`, `contact.deletion`, `contact.propertyChange` |
| Companies | `company.creation`, `company.deletion`, `company.propertyChange` |
| Deals | `deal.creation`, `deal.deletion`, `deal.propertyChange` |
| Tickets | `ticket.creation`, `ticket.deletion`, `ticket.propertyChange` |

### Delivery Details

- Payloads are **arrays** (up to 100 events per request)
- Validate with `X-HubSpot-Signature` header
- Retries: up to 10 times over ~24 hours
- Timeout: 5 seconds per delivery

### Limits

- 1,000 subscriptions per app
- Webhook deliveries don't count against API rate limits

---

## 9. Implementation Best Practices

### Performance

1. **Use webhooks** for change detection instead of polling
2. **Use batch endpoints** when operating on multiple records
3. **Cache static metadata** (pipelines, properties, owners)
4. **Use field masks** (`?properties=`) to minimize response size

### Rate Limiting

1. Read `X-HubSpot-RateLimit-*` headers (when present)
2. Implement exponential backoff on 429 responses
3. Keep error rate under 5% for Marketplace certification
4. Note: Search API responses don't include rate limit headers

### Webhook Handling

1. Treat delivery as **at-least-once** (implement idempotency)
2. Deduplicate by `(eventId, occurredAt, objectId)`
3. HubSpot does not guarantee uniqueness or ordering
4. Return 2xx quickly, process async if needed

### Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Validation error | Check request format, property values |
| 401 | Auth expired | Refresh token or re-authenticate |
| 403 | Permission denied | Check scopes, user permissions |
| 404 | Not found | Verify object ID exists |
| 429 | Rate limited | Backoff and retry |
| 5xx | Server error | Retry with backoff |

---

## 10. What's NOT in Our Current MCP

### Available but Not Implemented

| API | Why Consider Adding | Priority |
|-----|---------------------|----------|
| **Products/Line Items** | CPQ workflows, deal revenue | P0 |
| **Forms** | Lead capture, form submissions | P0 |
| **Analytics v2** | Traffic reports, sources | P1 |
| **Marketing Emails** | Campaign stats, email performance | P1 |
| **Invoices** | Commerce workflows | P2 |
| **Imports/Exports** | Bulk operations | P2 |

### Tier-Restricted (Limited Audience)

| API | Restriction |
|-----|-------------|
| Events v3 (Behavioral) | Enterprise only |
| Campaign Metrics | Marketing Hub Professional+ |
| Email Publish/Unpublish | Marketing Hub Enterprise |
| Export via OAuth | Requires Super Admin |

---

## Quick Reference: Common Scopes

```
oauth
crm.objects.contacts.read
crm.objects.contacts.write
crm.objects.companies.read
crm.objects.companies.write
crm.objects.deals.read
crm.objects.deals.write
crm.objects.owners.read
crm.schemas.contacts.read
crm.schemas.companies.read
crm.schemas.deals.read
tickets
content
forms
crm.objects.products.read
crm.objects.products.write
crm.objects.line_items.read
crm.objects.line_items.write
```

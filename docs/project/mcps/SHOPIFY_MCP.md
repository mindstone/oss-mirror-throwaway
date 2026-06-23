---
description: "Shopify MCP connector — store products, collections, customers, orders, inventory, metafields, Admin API setup, tools"
last_updated: "2026-02-24"
---

# Shopify MCP

Shopify store management: products, collections, customers, orders, draft orders, inventory, and metafields.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Shopify Admin API Documentation](https://shopify.dev/docs/api/admin-graphql) - Official API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **ID** | `shopify` |
| **Provider** | Community (`shopify-mcp`) |
| **Version** | `1.0.8` (pinned) |
| **Auth** | API key (Admin API Access Token + Store Domain) |
| **Status** | Added Feb 2026 |
| **Maturity** | Beta |

Shopify is the leading e-commerce platform for online stores. This connector uses the community-maintained `shopify-mcp` package by GeLi2001, which provides 30+ tools for managing store data via the Shopify GraphQL Admin API.


## Connector Catalog Entry

```json
{
  "id": "shopify",
  "name": "Shopify",
  "description": "Shopify store management: products, collections, customers, orders, draft orders, inventory, metafields. Search, create, update across your store.",
  "category": "sales",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "shopify-mcp@1.0.8"]
  },
  "icon": "shopping-bag",
  "popular": false,
  "verified": false,
  "verifiedSource": "https://github.com/GeLi2001/shopify-mcp",
  "requiresSetup": true,
  "setupUrl": "https://admin.shopify.com/",
  "setupUrlBehavior": "button",
  "setupInstructions": "1. Click 'Open Shopify' below to go to your Shopify admin\n2. Go to Settings → Apps and sales channels → Develop apps\n3. Click 'Create an app' and name it (e.g., 'Rebel AI')\n4. Click 'Configure Admin API scopes' and enable:\n   read_products, write_products, read_customers, write_customers,\n   read_orders, write_orders, read_draft_orders, write_draft_orders,\n   read_inventory, write_inventory, read_locations\n5. Click 'Install app' and confirm\n6. Copy the Admin API access token — you won't see it again!\n7. Paste your store domain and access token below\n\nNote: Requires a Shopify store with custom app development enabled. Node.js required.",
  "setupFields": [
    {
      "id": "domain",
      "label": "Store Domain",
      "type": "text",
      "placeholder": "your-store.myshopify.com",
      "envVar": "MYSHOPIFY_DOMAIN"
    },
    {
      "id": "accessToken",
      "label": "Admin API Access Token",
      "type": "password",
      "placeholder": "shpat_...",
      "envVar": "SHOPIFY_ACCESS_TOKEN"
    }
  ],
  "accountIdentity": "none",
  "maturity": "beta"
}
```


## Tools

The MCP provides 30+ tools across these categories:

| Category | Tools | Description |
|----------|-------|-------------|
| **Products** | `get_products`, `get_product`, `create_product`, `update_product` | Search, view, create, and update products with variants and media |
| **Collections** | `get_collections`, `get_collection`, `create_collection`, `update_collection` | Manage product collections (smart and custom) |
| **Customers** | `get_customers`, `get_customer`, `create_customer`, `update_customer` | Search, view, create, and update customer records |
| **Orders** | `get_orders`, `get_order`, `update_order` | Browse and manage orders with line items and fulfillment status |
| **Draft Orders** | `get_draft_orders`, `get_draft_order`, `create_draft_order`, `update_draft_order`, `complete_draft_order`, `delete_draft_order` | Full draft order lifecycle management |
| **Inventory** | `get_inventory_level`, `adjust_inventory`, `set_inventory` | Track and adjust inventory levels across locations |
| **Locations** | `get_locations` | List store locations for inventory management |
| **Metafields** | `get_metafields`, `set_metafield`, `delete_metafield` | Read and write custom metadata on any resource |
| **URL Redirects** | `get_url_redirects`, `create_url_redirect`, `update_url_redirect`, `delete_url_redirect` | Manage store URL redirects |
| **Analytics** | `get_shop` | Store-level information and configuration |
| **Bulk Operations** | Various | Bulk import/export capabilities |


## Usage Examples

**Browse products:**
```
Show me the top 10 products in my Shopify store
```

**Check inventory:**
```
What's the current inventory level for SKU REBEL-001?
```

**Manage orders:**
```
Show my unfulfilled orders from this week
```

**Customer lookup:**
```
Find the customer record for sarah@example.com
```

**Draft orders:**
```
Create a draft order for 2x "Premium Widget" for customer John Smith
```


## Setup

**Prerequisites:**
- A Shopify store with a paid plan
- Custom app development enabled (Settings → Apps and sales channels → Develop apps)
- Node.js installed locally

**Get your API credentials:**
1. Go to [Shopify Admin](https://admin.shopify.com/)
2. Navigate to **Settings → Apps and sales channels → Develop apps**
3. Click **Create an app** and name it (e.g., "Rebel AI")
4. Click **Configure Admin API scopes** and enable:
   - `read_products`, `write_products`
   - `read_customers`, `write_customers`
   - `read_orders`, `write_orders`
   - `read_draft_orders`, `write_draft_orders`
   - `read_inventory`, `write_inventory`
   - `read_locations`
5. Click **Install app** and confirm
6. Copy the **Admin API access token** (shown only once)

**Configure in Rebel:**
1. Go to **Settings → Connectors**
2. Find **Shopify** and click **Set up**
3. Enter your store domain (e.g., `your-store.myshopify.com`)
4. Paste the Admin API access token
5. Click **Connect**


## Technical Details

- **Type**: Community MCP (third-party)
- **Transport**: stdio (runs via npx)
- **Package**: `shopify-mcp@1.0.8`
- **License**: MIT
- **Author**: GeLi2001
- **Repository**: https://github.com/GeLi2001/shopify-mcp
- **API**: Shopify GraphQL Admin API
- **Environment Variables**:
  - `MYSHOPIFY_DOMAIN` (required) - Store domain (e.g., `your-store.myshopify.com`)
  - `SHOPIFY_ACCESS_TOKEN` (required) - Admin API access token


## Security Notes

- **Admin-level access**: The access token grants read/write access to store data based on the configured API scopes
- **Write operations available**: Unlike read-only MCPs, this connector can create and modify products, orders, customers, and inventory — configure scopes carefully
- **Version pinned**: Package version pinned to `1.0.8` to mitigate supply chain risk
- **Community maintained**: Not an official Shopify MCP — review the source before granting broad API scopes
- **Token shown once**: The Admin API access token is only displayed once during app installation; store it securely


## Known Limitations

- **Single store**: Each connector instance connects to one Shopify store
- **Community maintained**: May lag behind Shopify API changes
- **No webhook support**: Cannot receive real-time events (polls data on request)
- **GraphQL rate limits**: Subject to Shopify's API rate limiting (calculated cost-based throttling)
- **No Storefront API**: Only accesses the Admin API — no customer-facing storefront operations


## Troubleshooting

**"Missing required environment variables" error:**
1. Verify both Store Domain and Access Token are entered in Settings → Connectors
2. Disconnect and reconnect the Shopify connector

**"401 Unauthorized" or authentication errors:**
1. Verify the access token is correct (tokens start with `shpat_`)
2. Check that the custom app is still installed in your Shopify admin
3. Regenerate the access token if needed (requires reinstalling the app)

**"403 Forbidden" on specific operations:**
1. The app may not have the required API scope for that operation
2. Go to Shopify Admin → Settings → Apps → your app → Configure Admin API scopes
3. Add the missing scope and reinstall the app

**No data returned:**
- Verify the store domain format is correct (e.g., `your-store.myshopify.com`, not just `your-store`)
- Check that the store has data for the requested resource type


## References

- [Shopify Admin API Documentation](https://shopify.dev/docs/api/admin-graphql)
- [shopify-mcp GitHub Repository](https://github.com/GeLi2001/shopify-mcp)
- [shopify-mcp on npm](https://www.npmjs.com/package/shopify-mcp)

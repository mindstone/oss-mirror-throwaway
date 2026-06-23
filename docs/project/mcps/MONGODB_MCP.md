---
description: "MongoDB MCP connector — connection-string setup, read-only defaults, database querying, schema inspection, security guidance"
last_updated: "2025-12-26"
---

# MongoDB MCP

| Property | Value |
|----------|-------|
| **Provider** | Community (Official MongoDB MCP Server) |
| **Transport** | stdio via `npx mongodb-mcp-server` |
| **Auth** | MongoDB connection string (includes credentials) |
| **Status** | UNTESTED - needs validation |

## Overview

MongoDB integration via MongoDB's official MCP Server. Enables querying MongoDB databases and Atlas clusters, running aggregations, and inspecting collection schemas.

## Setup Requirements

1. **MongoDB Database** - Atlas cluster or self-hosted MongoDB instance
2. **Connection String** - MongoDB URI with credentials
3. **Node.js** - Required for `npx` execution

## Configuration

The connector uses Pattern 4c (community MCP with setup fields):
- `MDB_MCP_CONNECTION_STRING` - MongoDB connection URI

### Default Safety Settings

The connector is configured with safe defaults:
- `MDB_MCP_READ_ONLY=true` - Prevents write operations (insert, update, delete)
- `MDB_MCP_TELEMETRY=disabled` - Disables usage telemetry

## Available Tools

The official MongoDB MCP Server provides tools for:

| Category | Operations |
|----------|------------|
| **Read** | Find documents, aggregate, list databases/collections |
| **Metadata** | Get collection schemas, list indexes |
| **Atlas** | List clusters, manage Atlas resources (if API key configured) |

With read-only mode enabled (default), write operations are disabled:
- No document inserts/updates/deletes
- No collection drops
- No index modifications

## Connection String Format

### MongoDB Atlas
```
mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>
```

### Self-hosted MongoDB
```
mongodb://<username>:<password>@<host>:<port>/<database>
```

### Local Development
```
mongodb://localhost:27017/<database>
```

## Security Considerations

1. **Credentials in URI** - Connection strings contain passwords; stored securely in app settings
2. **Read-only Default** - Write operations disabled by default for safety
3. **Least Privilege** - Create a dedicated read-only MongoDB user for Rebel
4. **Network Access** - For Atlas, ensure IP whitelist allows connection from user's machine

### Creating a Read-Only User (Recommended)

For Atlas:
1. Go to Database Access → Add New Database User
2. Select "Read Only" built-in role
3. Restrict to specific databases if needed

For self-hosted:
```javascript
db.createUser({
  user: "rebel_readonly",
  pwd: "secure_password",
  roles: [{ role: "read", db: "your_database" }]
})
```

## Advanced Configuration

To enable write operations (not recommended), users can manually modify the MCP config to remove `MDB_MCP_READ_ONLY=true`. This requires editing the Super-MCP router config directly.

Additional options available via environment variables:
- `MDB_MCP_DISABLED_TOOLS` - Disable specific tool categories
- `MDB_MCP_INDEX_CHECK` - Reject queries that don't use indexes

## References

- [MongoDB MCP Server Docs](https://www.mongodb.com/docs/mcp-server/)
- [MongoDB MCP Server GitHub](https://github.com/mongodb-js/mongodb-mcp-server)
- [MongoDB Connection String Reference](https://www.mongodb.com/docs/manual/reference/connection-string/)
- [Announcing MongoDB MCP Server (Blog)](https://www.mongodb.com/company/blog/announcing-mongodb-mcp-server)

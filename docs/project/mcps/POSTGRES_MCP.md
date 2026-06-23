---
description: "PostgreSQL MCP connector — read-only SQL queries, schema inspection, connection URLs, SSL setup, security notes"
last_updated: "2025-12-25"
---

# PostgreSQL MCP

**Status:** Added Dec 2025 - UNTESTED (needs validation)

## Overview

Connect to any PostgreSQL database for read-only queries and schema inspection. Works with self-hosted Postgres, AWS RDS, Google Cloud SQL, Azure Database, or any Postgres-compatible database.

## Provider

- **Package:** `@zeddotdev/postgres-context-server`
- **Maintainer:** Zed Industries (Max Brunsfeld, Conrad Irwin)
- **License:** MIT
- **Source:** https://github.com/zed-industries/postgres-context-server

This is a patched fork of the original Anthropic reference implementation, with SQL injection vulnerabilities fixed.

## Tools

| Tool | Description |
|------|-------------|
| `query` | Run read-only SQL queries against the connected database |
| `pg-schema` | Retrieve table schemas (all tables or a specific table) |

## Access Mode

**Read-only only.** All queries execute within a `BEGIN TRANSACTION READ ONLY` block and use prepared statements to prevent SQL injection.

## Setup

1. Go to Settings → Connectors → PostgreSQL
2. Click "Set up"
3. Enter your database connection URL in the format:
   ```
   postgresql://user:password@host:port/database
   ```

### Connection URL Examples

| Environment | URL Format |
|-------------|------------|
| Local | `postgresql://localhost:5432/mydb` |
| Local with auth | `postgresql://myuser:mypassword@localhost:5432/mydb` |
| AWS RDS | `postgresql://admin:password@mydb.abc123.us-east-1.rds.amazonaws.com:5432/mydb` |
| Cloud SQL | `postgresql://user:password@/mydb?host=/cloudsql/project:region:instance` |

### SSL Connections

For databases requiring SSL, append `?sslmode=require` to the URL:
```
postgresql://user:password@host:5432/database?sslmode=require
```

## Requirements

- Node.js installed locally (for `npx`)
- Network access to the PostgreSQL server
- Database credentials with SELECT permissions

## Comparison with Neon/Supabase

| Feature | PostgreSQL MCP | Neon | Supabase |
|---------|---------------|------|----------|
| Self-hosted Postgres | Yes | No | Limited |
| AWS RDS / Cloud SQL | Yes | No | No |
| Platform features | No | Yes (branching, etc.) | Yes (auth, storage, etc.) |
| OAuth setup | No (connection URL) | Yes | Yes |

Use **PostgreSQL MCP** for generic Postgres databases. Use **Neon** or **Supabase** if you're on those specific platforms and want their additional features.

## Troubleshooting

### Connection refused
- Check that the database server is running and accessible
- Verify firewall rules allow connections from your machine
- For cloud databases, ensure your IP is allowlisted

### Authentication failed
- Double-check username and password in the connection URL
- Ensure the user has SELECT permissions on the target database

### SSL required
- Add `?sslmode=require` to the connection URL
- Some cloud providers require SSL for all connections

## Security Notes

- Connection URLs contain credentials - treat them as secrets
- The MCP server only allows read-only queries
- Credentials are stored in your local Super-MCP configuration
- Never share your connection URL or commit it to version control

## References

- [PostgreSQL Connection URIs](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS)
- [Zed postgres-context-server](https://github.com/zed-industries/postgres-context-server)
- [SQL injection fix (Datadog)](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-postgres-mcp-server/)

/**
 * Xero MCP Mock Tests — get_xero_invoice_online_url & get_xero_invoice_as_pdf
 *
 * Tests tool behavior with mocked HTTP responses — no real API keys needed.
 * Intercepts both identity.xero.com (auth) and api.xero.com (API calls).
 *
 * Run: npx vitest run resources/mcp/xero/test-mcp.test.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  createMcpTestClientWithMockApi,
  type McpTestClient,
  type MockApiServer,
  type MockRequest,
} from '../../../scripts/mcp-test-harness';

const XERO_BUILD = join(__dirname, 'build', 'index.js');
const canRun = existsSync(XERO_BUILD);

const MOCK_TENANT_ID = 'tenant-abc-123';
const MOCK_ACCESS_TOKEN = 'mock-access-token-xyz';

const mockAccrecInvoice = {
  InvoiceID: 'inv-accrec-001',
  InvoiceNumber: 'INV-0001',
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  Contact: { Name: 'Acme Corp' },
  Total: 1500.00,
};

const mockAccpayInvoice = {
  InvoiceID: 'inv-accpay-002',
  InvoiceNumber: 'BILL-0001',
  Type: 'ACCPAY',
  Status: 'AUTHORISED',
  Contact: { Name: 'Supplier Co' },
  Total: 750.00,
};

const mockOnlineInvoiceUrl = 'https://in.xero.com/p8IT9EAEDJj0s6h1wMjuhguWIkHEU81iiU4ZtoiD';

const mockPdfBytes = Buffer.from('%PDF-1.4 mock invoice pdf content here', 'utf-8');

describe.skipIf(!canRun)('Xero MCP — get_xero_invoice_online_url & get_xero_invoice_as_pdf', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'xero',
      serverScript: XERO_BUILD,
      interceptDomains: ['identity.xero.com', 'api.xero.com'],
      routes: [
        // Auth: token endpoint
        {
          method: 'POST',
          path: '/connect/token',
          handler: {
            body: {
              access_token: MOCK_ACCESS_TOKEN,
              token_type: 'Bearer',
              expires_in: 1800,
            },
          },
        },
        // Auth: connections endpoint (returns tenant ID)
        {
          method: 'GET',
          path: '/connections',
          handler: {
            body: [{ tenantId: MOCK_TENANT_ID, tenantName: 'Test Org' }],
          },
        },
        // GET /Invoices/{id} — ACCREC invoice
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-accrec-001',
          handler: (req: MockRequest) => {
            const accept = req.headers['accept'] || '';
            if (accept === 'application/pdf') {
              return {
                headers: { 'content-type': 'application/pdf' },
                rawBody: mockPdfBytes,
              };
            }
            return { body: { Invoices: [mockAccrecInvoice] } };
          },
        },
        // GET /Invoices/{id} — ACCPAY invoice
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-accpay-002',
          handler: (req: MockRequest) => {
            const accept = req.headers['accept'] || '';
            if (accept === 'application/pdf') {
              return {
                headers: { 'content-type': 'application/pdf' },
                rawBody: mockPdfBytes,
              };
            }
            return { body: { Invoices: [mockAccpayInvoice] } };
          },
        },
        // GET /Invoices/{id}/OnlineInvoice — success
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-accrec-001/OnlineInvoice',
          handler: {
            body: {
              OnlineInvoices: [{ OnlineInvoiceUrl: mockOnlineInvoiceUrl }],
            },
          },
        },
        // GET /Invoices/{id} — not found
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-nonexistent',
          handler: {
            status: 404,
            body: { Message: 'The resource you\'re looking for cannot be found' },
          },
        },
        // GET /Invoices/{id}/OnlineInvoice — no URL (online invoicing disabled)
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-no-online/OnlineInvoice',
          handler: {
            body: { OnlineInvoices: [] },
          },
        },
        // GET /Invoices/{id} — invoice with no online URL enabled
        {
          method: 'GET',
          path: '/api.xro/2.0/Invoices/inv-no-online',
          handler: {
            body: {
              Invoices: [{
                InvoiceID: 'inv-no-online',
                InvoiceNumber: 'INV-0099',
                Type: 'ACCREC',
                Status: 'AUTHORISED',
                Contact: { Name: 'No Online Corp' },
                Total: 500.00,
              }],
            },
          },
        },
      ],
      env: {
        XERO_CLIENT_ID: 'mock-client-id',
        XERO_CLIENT_SECRET: 'mock-client-secret',
      },
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  // ─── get_xero_invoice_online_url ──────────────────────────────────────────

  describe('get_xero_invoice_online_url', () => {
    it('returns online URL for ACCREC invoice', async () => {
      const result = await client.callToolJson<{
        ok: boolean;
        invoiceId: string;
        invoiceNumber: string;
        onlineUrl: string;
      }>('get_xero_invoice_online_url', { invoiceId: 'inv-accrec-001' });

      expect(result.ok).toBe(true);
      expect(result.invoiceId).toBe('inv-accrec-001');
      expect(result.invoiceNumber).toBe('INV-0001');
      expect(result.onlineUrl).toBe(mockOnlineInvoiceUrl);
      expect(result.onlineUrl).toMatch(/^https:\/\/in\.xero\.com\//);
    });

    it('returns friendly error for ACCPAY invoice', async () => {
      const result = await client.callToolJson<{
        ok: boolean;
        error: string;
        invoiceType: string;
      }>('get_xero_invoice_online_url', { invoiceId: 'inv-accpay-002' });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('sales invoices');
      expect(result.error).toContain('ACCREC');
      expect(result.invoiceType).toBe('ACCPAY');
    });

    it('returns error when invoiceId is missing', async () => {
      const result = await client.callToolJson<{ ok: boolean; error: string }>(
        'get_xero_invoice_online_url',
        {},
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('invoiceId is required');
    });

    it('returns null URL when online invoicing is not enabled', async () => {
      const result = await client.callToolJson<{
        ok: boolean;
        invoiceId: string;
        onlineUrl: string | null;
        message: string;
      }>('get_xero_invoice_online_url', { invoiceId: 'inv-no-online' });

      expect(result.ok).toBe(true);
      expect(result.invoiceId).toBe('inv-no-online');
      expect(result.onlineUrl).toBeNull();
      expect(result.message).toContain('online');
    });

    it('returns error for non-existent invoice', async () => {
      const result = await client.callToolJson<{ ok: boolean; error: string }>(
        'get_xero_invoice_online_url',
        { invoiceId: 'inv-nonexistent' },
      );

      expect(result.ok).toBe(false);
    });
  });

  // ─── get_xero_invoice_as_pdf ──────────────────────────────────────────────

  describe('get_xero_invoice_as_pdf', () => {
    it('returns base64-encoded PDF for ACCREC invoice', async () => {
      const result = await client.callToolJson<{
        ok: boolean;
        invoiceId: string;
        mimeType: string;
        contentLength: number;
        encoding: string;
        content: string;
      }>('get_xero_invoice_as_pdf', { invoiceId: 'inv-accrec-001' });

      expect(result.ok).toBe(true);
      expect(result.invoiceId).toBe('inv-accrec-001');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.encoding).toBe('base64');
      expect(result.contentLength).toBeGreaterThan(0);
      // Verify content is valid base64 that decodes to our mock PDF
      const decoded = Buffer.from(result.content, 'base64').toString('utf-8');
      expect(decoded).toContain('%PDF');
    });

    it('returns base64-encoded PDF for ACCPAY invoice (bills get PDFs too)', async () => {
      const result = await client.callToolJson<{
        ok: boolean;
        invoiceId: string;
        mimeType: string;
      }>('get_xero_invoice_as_pdf', { invoiceId: 'inv-accpay-002' });

      expect(result.ok).toBe(true);
      expect(result.invoiceId).toBe('inv-accpay-002');
      expect(result.mimeType).toBe('application/pdf');
    });

    it('returns error when invoiceId is missing', async () => {
      const result = await client.callToolJson<{ ok: boolean; error: string }>(
        'get_xero_invoice_as_pdf',
        {},
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('invoiceId is required');
    });
  });
});
